// JMAP for Calendars handlers backed by CalDAV (RFC 4791): Calendar/get and
// CalendarEvent/get, /query, /set and /parse. Ids follow the
// contacts scheme - base64url of the collection href, and of
// "collectionHref\nresourceHref" for events.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CalDavClient, type CalendarInfo } from "../../caldav/client.js";
import { davOptions } from "../../carddav/client.js";
import { eventToIcal, highestSequence, icalToEvent, icalToEvents, localToUtc, type JsEvent } from "../../caldav/ical.js";
import { applyPatch, errorFor, setError } from "./contacts.js";
import { mapWithConcurrency } from "../../util/concurrency.js";
import { log } from "../../util/log.js";
import type { Credentials } from "../../auth/credentials.js";
import type { ProviderConfig } from "../../util/config.js";
import type { AccountRow, Store } from "../../state/store.js";
import type { ImapPool } from "../../imap/pool.js";
import { withMailbox } from "../../imap/client.js";
import { decodeBlobId, decodeEmailId } from "../../mapping/ids.js";
import { accountNotFound, JmapError, unsupportedFilter } from "../errors.js";

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
  return new CalDavClient(davOptions(ctx.provider.caldav, ctx.creds));
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
  uid?: string;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  owner?: string;
  attendee?: string;
  operator?: string;
  conditions?: EventFilter[];
}

// Text conditions of the JMAP Calendars filter: case-insensitive substring
// matches on the event (its overrides included); `text` looks in all of them.
const TEXT_KEYS = ["text", "title", "description", "location", "owner", "attendee"] as const;
type TextKey = (typeof TEXT_KEYS)[number];

const FILTER_KEYS = new Set<string>(["inCalendar", "inCalendars", "after", "before", "uid", "operator", "conditions", ...TEXT_KEYS]);

/** A filter reduced to what CalDAV can answer: calendars, a time range, a uid. */
interface EventQueryPlan {
  /** Calendar ids the event must be in; null = any. */
  calendars: Set<string> | null;
  after?: string;
  before?: string;
  uid?: string;
  /** Text conditions; all must match. */
  texts: { key: TextKey; value: string }[];
}

// Answering a filter we can't evaluate with every event is worse than failing:
// Bulwark looks up a series' master with { uid } and edits the first recurring
// event it gets back, which truncated an unrelated series before uid was
// supported here.
//
// What we can evaluate is an AND of calendar, range and uid conditions, in any
// nesting: a condition with several keys is an AND of its keys (RFC 8620
// §5.5), nested ANDs flatten, and an OR is fine as long as it only picks
// calendars - that is how a client sends "this range, in these calendars".
// Anything else (NOT, an OR over ranges or uids) is refused.
function planFilter(f: EventFilter | undefined): EventQueryPlan {
  const plan: EventQueryPlan = { calendars: null, texts: [] };
  if (f) addToPlan(f, plan);
  return plan;
}

function addToPlan(f: EventFilter, plan: EventQueryPlan): void {
  const unknown = Object.keys(f).filter((k) => !FILTER_KEYS.has(k));
  if (unknown.length) throw unsupportedFilter(`unsupported CalendarEvent filter: ${unknown.join(", ")}`);

  if (f.operator !== undefined) {
    const conditions = f.conditions ?? [];
    if (f.operator === "AND") {
      for (const c of conditions) addToPlan(c, plan);
    } else if (f.operator === "OR") {
      const ids = conditions.map(calendarIdsOnly);
      if (ids.some((x) => x === null)) throw unsupportedFilter("only calendar conditions are supported inside OR");
      restrictCalendars(plan, new Set((ids as string[][]).flat()));
    } else {
      throw unsupportedFilter(`unsupported CalendarEvent filter operator: ${String(f.operator)}`);
    }
    return;
  }

  if (f.inCalendar !== undefined) restrictCalendars(plan, new Set([f.inCalendar]));
  if (f.inCalendars !== undefined) restrictCalendars(plan, new Set(f.inCalendars));
  // Several bounds in one AND: the narrowest wins. LocalDateTimes of the same
  // zone compare as strings.
  if (f.after !== undefined && (plan.after === undefined || f.after > plan.after)) plan.after = f.after;
  if (f.before !== undefined && (plan.before === undefined || f.before < plan.before)) plan.before = f.before;
  for (const key of TEXT_KEYS) {
    const value = f[key];
    if (typeof value === "string" && value.trim()) plan.texts.push({ key, value: value.trim().toLowerCase() });
  }
  if (f.uid !== undefined) {
    // Two different uids can't both match; an impossible uid keeps that true.
    plan.uid = plan.uid === undefined || plan.uid === f.uid ? f.uid : "\0no-such-uid";
  }
}

/** The calendar ids a condition names when it names nothing else, else null. */
function calendarIdsOnly(c: EventFilter): string[] | null {
  if (c.operator === "OR") {
    const nested = (c.conditions ?? []).map(calendarIdsOnly);
    return nested.some((x) => x === null) ? null : (nested as string[][]).flat();
  }
  const keys = Object.keys(c);
  if (keys.length === 1 && c.inCalendar !== undefined) return [c.inCalendar];
  if (keys.length === 1 && c.inCalendars !== undefined) return c.inCalendars;
  return null;
}

function restrictCalendars(plan: EventQueryPlan, ids: Set<string>): void {
  plan.calendars = plan.calendars ? new Set([...plan.calendars].filter((id) => ids.has(id))) : ids;
}

async function queryAll(ctx: CalendarCtx, filter?: EventFilter, timeZone?: string): Promise<{ ids: string[]; state: string }> {
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const plan = planFilter(filter);
  const wanted = plan.calendars;
  // after/before are LocalDateTimes in the request's time zone (UTC by default).
  const zone = timeZone ?? "Etc/UTC";
  const range = {
    after: plan.after ? localToUtc(plan.after.slice(0, 19), zone) : undefined,
    before: plan.before ? localToUtc(plan.before.slice(0, 19), zone) : undefined,
  };
  const targets = cals.filter((c) => !wanted || wanted.has(encodeId(c.href)));
  const perCal = await mapWithConcurrency(targets, 4, async (c) => {
    let hrefs = await client.queryEvents(c.href, range);
    // CalDAV has a UID prop-filter, but servers are free to ignore text
    // matches (mailbox.org does), so match on the bodies instead; they mostly
    // come from the body cache.
    // Text is matched the same way, CalDAV text-match being optional too.
    if (plan.uid !== undefined || plan.texts.length) {
      const res = await client.multiGetEvents(c.href, hrefs);
      hrefs = res
        .filter((r) => {
          const ev = icalToEvent(r.data, "", "");
          return !!ev && (plan.uid === undefined || ev.uid === plan.uid) && plan.texts.every((t) => matchesText(ev, t.key, t.value));
        })
        .map((r) => r.href);
    }
    return hrefs.map((h) => encodeId(`${c.href}\n${h}`));
  });
  return { ids: perCal.flat(), state: state(cals) };
}

/** The strings a text condition looks at, from the event and its overrides. */
function textFields(ev: JsEvent, key: TextKey): string[] {
  const versions: Record<string, unknown>[] = [ev, ...Object.values((ev.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>)];
  const out: string[] = [];
  const people = (role: "owner" | "attendee") =>
    Object.values((ev.participants ?? {}) as Record<string, { name?: string | null; email?: string; roles?: Record<string, boolean> }>)
      .filter((p) => p.roles?.[role])
      .flatMap((p) => [p.name ?? "", p.email ?? ""]);
  for (const v of versions) {
    if (key === "title" || key === "text") out.push(String(v.title ?? ""));
    if (key === "description" || key === "text") out.push(String(v.description ?? ""));
    if (key === "location" || key === "text") {
      for (const l of Object.values((v.locations ?? {}) as Record<string, { name?: string }>)) out.push(l?.name ?? "");
    }
  }
  if (key === "owner" || key === "text") out.push(...people("owner"));
  if (key === "attendee" || key === "text") out.push(...people("attendee"));
  return out;
}

function matchesText(ev: JsEvent, key: TextKey, needle: string): boolean {
  return textFields(ev, key).some((s) => s.toLowerCase().includes(needle));
}

export async function calendarEventQuery(
  args: { accountId: string; filter?: EventFilter; position?: number; limit?: number; timeZone?: string },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  planFilter(args.filter); // refuse what we can't evaluate before any CalDAV call
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

// Per-item failures go back in notCreated / notUpdated / notDestroyed inside a
// 200 response, so the request log never shows them. Log them here, with the
// property names the client sent, since the browser is the only other place
// they surface.
function itemFailed(op: string, id: string, e: unknown, props?: string[]): SetError {
  const err = errorFor(e);
  log.warn({ op, id, ...err, ...(props ? { props } : {}) }, "CalendarEvent/set item failed");
  return err;
}

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
      notCreated[cid] = itemFailed("create", cid, e, Object.keys(ev));
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    const parts = splitEventId(id);
    // Ids we didn't mint include Bulwark's synthetic-id probe; answering
    // invalidProperties (not notFound) tells it we don't take synthetic
    // occurrence ids, so it keeps expanding series itself. Not logged: the
    // probe runs on every calendar load.
    if (!parts) {
      notUpdated[id] = setError("invalidProperties", "not an event id");
      continue;
    }
    try {
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
      // Overrides are written with the master's SEQUENCE, so bump past the
      // highest one stored: writing an override back with a lower SEQUENCE
      // than it has is rejected with 412.
      if (!("sequence" in p)) current.sequence = Math.max(Number(current.sequence) || 0, highestSequence(res.data)) + 1;
      await client.putEvent(parts.href, eventToIcal(current, res.data), res.etag);
      updated[id] = null;
    } catch (e) {
      notUpdated[id] = itemFailed("update", id, e, Object.keys(patch));
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      const parts = splitEventId(id);
      if (!parts || !calById.has(encodeId(parts.calHref))) throw new JmapError("notFound", "no such event");
      await client.deleteEvent(parts.href);
      destroyed.push(id);
    } catch (e) {
      notDestroyed[id] = itemFailed("destroy", id, e);
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

// -- CalendarEventNotification/query, /get ----------------------------------------

// CalDAV has no notification inbox. Bulwark polls these on every login and
// logs an error when the methods are missing, so answer with an empty one.
export function calendarEventNotificationQuery(args: { accountId: string }, account: AccountRow) {
  if (args.accountId !== String(account.id)) throw accountNotFound();
  return { accountId: args.accountId, queryState: "0", canCalculateChanges: false, position: 0, total: 0, ids: [] };
}

export function calendarEventNotificationGet(args: { accountId: string; ids?: string[] | null }, account: AccountRow) {
  if (args.accountId !== String(account.id)) throw accountNotFound();
  return { accountId: args.accountId, state: "0", list: [], notFound: args.ids ?? [] };
}

// -- CalendarEvent/parse -----------------------------------------------------------

// Bulwark parses .ics files here in two places: its calendar import uploads
// the file first, and the invitation banner passes the blobId of the mail's
// text/calendar part. Parsing needs no CalDAV, only the blob's bytes.
export async function calendarEventParse(
  args: { accountId: string; blobIds: string[] },
  ctx: { account: AccountRow; store: Store; pool: ImapPool },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const parsed: Record<string, JsEvent[]> = {};
  const notFound: string[] = [];
  const notParsable: string[] = [];
  for (const blobId of args.blobIds ?? []) {
    const body = await readBlob(blobId, ctx);
    if (!body) {
      notFound.push(blobId);
      continue;
    }
    const events = icalToEvents(body.toString("utf8"));
    if (events.length) parsed[blobId] = events;
    else notParsable.push(blobId);
  }
  return { accountId: args.accountId, parsed, notParsable, notFound };
}

// The same lookup the download route does: uploads from SQLite, mail parts
// from the blob cache or else an IMAP fetch. Invitations are a few KB, so we
// buffer instead of streaming, and leave caching to the download route.
async function readBlob(
  blobId: string,
  ctx: { account: AccountRow; store: Store; pool: ImapPool },
): Promise<Buffer | null> {
  if (blobId.startsWith("U")) return ctx.store.getUpload(blobId, ctx.account.id)?.body ?? null;
  const cached = ctx.store.getCachedBlob(blobId, ctx.account.id);
  if (cached) return cached.body;

  let part: { emailId: string; partId: string | null };
  let email: { mailboxIdx: number; uid: number };
  try {
    part = decodeBlobId(blobId);
    email = decodeEmailId(part.emailId);
  } catch {
    return null;
  }
  const mbox = ctx.store
    .prep(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(email.mailboxIdx, ctx.account.id) as { id: number; name: string } | undefined;
  if (!mbox) return null;

  return ctx.pool.withConnection(ctx.account, "interactive", (client) =>
    withMailbox(client, mbox.name, async () => {
      const dl = await client.download(`${email.uid}`, part.partId ?? undefined, { uid: true });
      // imapflow answers `{}` rather than null for an expunged message or part.
      if (!dl?.content) return null;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of dl.content) chunks.push(chunk as Buffer);
      } catch (e) {
        // Same as the download route: a FETCH that broke off mid-literal
        // leaves the connection unparseable, so drop it rather than pool it.
        client.close();
        throw e;
      }
      return Buffer.concat(chunks);
    }),
  );
}
