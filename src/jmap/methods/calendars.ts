// JMAP for Calendars handlers backed by CalDAV (RFC 4791): Calendar/get and
// CalendarEvent/get, /query and /set. Ids follow the
// contacts scheme - base64url of the collection href, and of
// "collectionHref\nresourceHref" for events.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CalDavClient, type CalendarInfo } from "../../caldav/client.js";
import { eventToIcal, icalToEvent, localToUtc, type JsEvent } from "../../caldav/ical.js";
import { applyPatch, errorFor, setError } from "./contacts.js";
import { mapWithConcurrency } from "../../util/concurrency.js";
import type { Credentials } from "../../auth/credentials.js";
import type { ProviderConfig } from "../../util/config.js";
import type { AccountRow } from "../../state/store.js";
import { accountNotFound, JmapError } from "../errors.js";

export interface CalendarCtx {
  account: AccountRow;
  provider: ProviderConfig;
  creds: Credentials;
}

// Events can be written; the calendars themselves (create, rename, share)
// cannot yet.
const RIGHTS = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayAdmin: false,
  mayDelete: false,
};

export function calendarsAvailable(provider: ProviderConfig): boolean {
  return provider.caldav != null;
}

function makeClient(ctx: CalendarCtx): CalDavClient {
  if (!ctx.provider.caldav) throw new JmapError("forbidden", "Calendars are not configured for this provider");
  const { username, password, ...cfg } = ctx.provider.caldav;
  const creds: Credentials = username && password ? { mech: "PLAIN", username, password } : ctx.creds;
  return new CalDavClient({ ...cfg, creds });
}

const encodeId = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const decodeId = (id: string) => Buffer.from(id, "base64url").toString("utf8");

function splitEventId(id: string): { calHref: string; href: string } | null {
  const d = decodeId(id);
  const i = d.indexOf("\n");
  return i < 0 ? null : { calHref: d.slice(0, i), href: d.slice(i + 1) };
}

function state(cals: CalendarInfo[]): string {
  const h = crypto.createHash("sha1");
  for (const c of cals) h.update(`${c.href}\u0000${c.ctag ?? ""}\u0000`);
  return h.digest("base64url").slice(0, 16);
}

function checkAccount(accountId: string, ctx: CalendarCtx): void {
  if (accountId !== String(ctx.account.id)) throw accountNotFound();
}

// -- Calendar/get ------------------------------------------------------------------

export async function calendarGet(args: { accountId: string; ids?: string[] | null }, ctx: CalendarCtx) {
  checkAccount(args.accountId, ctx);
  const cals = await makeClient(ctx).listCalendars();
  const all = cals.map((c, i) => ({
    id: encodeId(c.href),
    name: c.displayName,
    description: c.description,
    color: c.color,
    sortOrder: i,
    isSubscribed: true,
    isVisible: true,
    isDefault: i === 0,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: null,
    shareWith: null,
    myRights: RIGHTS,
  }));
  const ids = args.ids ?? null;
  return {
    accountId: args.accountId,
    state: state(cals),
    list: ids ? all.filter((c) => ids.includes(c.id)) : all,
    notFound: ids ? ids.filter((id) => !all.some((c) => c.id === id)) : [],
  };
}

// -- CalendarEvent/query -----------------------------------------------------------

interface EventFilter {
  inCalendar?: string;
  inCalendars?: string[];
  after?: string;
  before?: string;
  operator?: string;
  conditions?: EventFilter[];
}

/** Calendar ids named by an inCalendar / inCalendars / OR-of-inCalendar filter; null = all. */
function wantedCalendars(f: EventFilter | undefined): Set<string> | null {
  if (!f) return null;
  const ids = [f.inCalendar, ...(f.inCalendars ?? []), ...(f.conditions ?? []).map((c) => c.inCalendar)]
    .filter((x): x is string => !!x);
  return ids.length ? new Set(ids) : null;
}

async function queryAll(ctx: CalendarCtx, filter?: EventFilter, timeZone?: string): Promise<{ ids: string[]; state: string }> {
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const wanted = wantedCalendars(filter);
  // after/before are LocalDateTimes in the request's time zone (UTC by default).
  const zone = timeZone ?? "Etc/UTC";
  const range = {
    after: filter?.after ? localToUtc(filter.after.slice(0, 19), zone) : undefined,
    before: filter?.before ? localToUtc(filter.before.slice(0, 19), zone) : undefined,
  };
  const targets = cals.filter((c) => !wanted || wanted.has(encodeId(c.href)));
  const perCal = await mapWithConcurrency(targets, 4, async (c) =>
    (await client.queryEvents(c.href, range)).map((h) => encodeId(`${c.href}\n${h}`)),
  );
  return { ids: perCal.flat(), state: state(cals) };
}

export async function calendarEventQuery(
  args: { accountId: string; filter?: EventFilter; position?: number; limit?: number; timeZone?: string },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  // We don't implement `sort`: ids come back in server order, and Bulwark
  // sorts the expanded occurrences itself anyway.
  const { ids, state: s } = await queryAll(ctx, args.filter, args.timeZone);
  const position = Math.max(0, args.position ?? 0);
  const limit = args.limit && args.limit > 0 ? args.limit : ids.length;
  return {
    accountId: args.accountId,
    queryState: s,
    canCalculateChanges: false,
    position,
    total: ids.length,
    ids: ids.slice(position, position + limit),
  };
}

// -- CalendarEvent/get -------------------------------------------------------------

export async function calendarEventGet(args: { accountId: string; ids?: string[] | null }, ctx: CalendarCtx) {
  checkAccount(args.accountId, ctx);
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const ids = args.ids ?? (await queryAll(ctx)).ids;

  const byCal = new Map<string, Map<string, string>>(); // calHref -> href -> id
  const notFound: string[] = [];
  for (const id of ids) {
    const parts = splitEventId(id);
    if (!parts || !cals.some((c) => c.href === parts.calHref)) {
      notFound.push(id);
      continue;
    }
    if (!byCal.has(parts.calHref)) byCal.set(parts.calHref, new Map());
    byCal.get(parts.calHref)!.set(parts.href, id);
  }

  const list: JsEvent[] = [];
  await mapWithConcurrency([...byCal], 4, async ([calHref, hrefs]) => {
    const found = new Set<string>();
    for (const r of await client.multiGetEvents(calHref, [...hrefs.keys()])) {
      const id = hrefs.get(r.href);
      if (!id) continue;
      const ev = icalToEvent(r.data, id, encodeId(calHref));
      if (ev) {
        list.push(ev);
        found.add(r.href);
      }
    }
    for (const [href, id] of hrefs) if (!found.has(href)) notFound.push(id);
  });
  return { accountId: args.accountId, state: state(cals), list, notFound };
}

// -- CalendarEvent/set -------------------------------------------------------------

type SetError = ReturnType<typeof setError>;

// Server-set or derived properties; a client sending them back is ignored
// rather than rejected.
const EVENT_READ_ONLY = new Set(["id", "uid", "@type", "created", "updated", "utcStart", "utcEnd", "baseEventId", "isOrigin", "isDraft"]);

export async function calendarEventSet(
  args: {
    accountId: string;
    ifInState?: string | null;
    create?: Record<string, JsEvent> | null;
    update?: Record<string, Record<string, unknown>> | null;
    destroy?: string[] | null;
  },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const oldState = state(cals);
  if (args.ifInState && args.ifInState !== oldState) throw new JmapError("stateMismatch", "ifInState does not match");

  const created: Record<string, { id: string; uid: string }> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  const calById = new Map(cals.map((c) => [encodeId(c.href), c]));

  for (const [cid, ev] of Object.entries(args.create ?? {})) {
    try {
      const wanted = Object.keys((ev.calendarIds ?? {}) as Record<string, boolean>);
      const cal = wanted.length ? calById.get(wanted[0]!) : cals[0];
      if (!cal) throw new JmapError("invalidProperties", "unknown calendar in calendarIds");
      const uid = typeof ev.uid === "string" && ev.uid ? ev.uid : crypto.randomUUID();
      // The resource name only has to be unique in the collection; the UID is,
      // and keeping to a safe character set spares us URL-encoding questions.
      const href = `${cal.href}${uid.replace(/[^\w.@-]/g, "_")}.ics`;
      const event: JsEvent = { ...ev, uid, sequence: 0, created: new Date().toISOString() };
      await client.putEvent(href, eventToIcal(event));
      created[cid] = { id: encodeId(`${cal.href}\n${href}`), uid };
    } catch (e) {
      notCreated[cid] = errorFor(e);
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      const parts = splitEventId(id);
      // Ids we didn't mint include Bulwark's synthetic-id probe; answering
      // invalidProperties (not notFound) tells it we don't take synthetic
      // occurrence ids, so it keeps expanding series itself.
      if (!parts) throw new JmapError("invalidProperties", "not an event id");
      const calId = encodeId(parts.calHref);
      if (!calById.has(calId)) throw new JmapError("notFound", "no such calendar");
      const [res] = await client.fetchEvents(parts.calHref, [parts.href]);
      const current = res && icalToEvent(res.data, id, calId);
      if (!res || !current) throw new JmapError("notFound", "no such event");

      const p = Object.fromEntries(Object.entries(patch).filter(([k]) => !EVENT_READ_ONLY.has(k.split("/")[0]!)));
      if ("calendarIds" in p && JSON.stringify(p.calendarIds) !== JSON.stringify(current.calendarIds)) {
        throw new JmapError("invalidProperties", "moving events between calendars is not supported");
      }
      applyPatch(current, p);
      if (!("sequence" in p)) current.sequence = (Number(current.sequence) || 0) + 1;
      await client.putEvent(parts.href, eventToIcal(current, res.data), res.etag);
      updated[id] = null;
    } catch (e) {
      notUpdated[id] = errorFor(e);
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      const parts = splitEventId(id);
      if (!parts || !calById.has(encodeId(parts.calHref))) throw new JmapError("notFound", "no such event");
      await client.deleteEvent(parts.href);
      destroyed.push(id);
    } catch (e) {
      notDestroyed[id] = errorFor(e);
    }
  }

  const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
  return {
    accountId: args.accountId,
    oldState,
    newState: state(await client.listCalendars()),
    created: orNull(created),
    updated: orNull(updated),
    destroyed: destroyed.length ? destroyed : null,
    notCreated: orNull(notCreated),
    notUpdated: orNull(notUpdated),
    notDestroyed: orNull(notDestroyed),
  };
}
