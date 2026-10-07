// JMAP for Calendars handlers backed by CalDAV (RFC 4791). Read-only for now:
// Calendar/get, CalendarEvent/query, CalendarEvent/get. Ids follow the
// contacts scheme - base64url of the collection href, and of
// "collectionHref\nresourceHref" for events.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CalDavClient, type CalendarInfo } from "../../caldav/client.js";
import { icalToEvent, localToUtc, type JsEvent } from "../../caldav/ical.js";
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

const READ_ONLY_RIGHTS = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: false,
  mayWriteOwn: false,
  mayUpdatePrivate: false,
  mayRSVP: false,
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
    myRights: READ_ONLY_RIGHTS,
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
  // ponytail: no sort support, results come in server order; the client sorts.
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
