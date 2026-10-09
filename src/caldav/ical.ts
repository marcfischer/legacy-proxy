// iCalendar (RFC 5545) <-> JSCalendar (RFC 8984) for JMAP for Calendars.
// One CalDAV resource (a master VEVENT plus any RECURRENCE-ID
// overrides) becomes one JSCalendar Event. Recurrences are passed through as
// rules, not expanded - the client expands them itself.

import { escapeValue, fold, parseLine, unescapeValue, unfold, type ParsedLine } from "../carddav/vcard.js";
import { applyPatch } from "../jmap/methods/contacts.js";

interface Component {
  type: string;
  props: ParsedLine[];
  children: Component[];
}

export type JsEvent = Record<string, unknown>;

/** Parse an iCalendar body into its component tree (top level: VCALENDARs). */
export function parseComponents(text: string): Component[] {
  const root: Component = { type: "", props: [], children: [] };
  const stack = [root];
  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = parseLine(line, true);
    if (!p) continue;
    const top = stack[stack.length - 1]!;
    if (p.name === "BEGIN") {
      const c: Component = { type: p.value.toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      top.props.push(p);
    }
  }
  return root.children;
}

/**
 * Convert one CalDAV resource to a JSCalendar Event, or null when it holds
 * no VEVENT (e.g. a VTODO).
 */
export function icalToEvent(text: string, id: string, calendarId: string): JsEvent | null {
  return veventsToEvent(vevents(text), id, calendarId);
}

/**
 * Convert a whole iCalendar file - an .ics import or an invitation - to one
 * JSCalendar Event per UID, for CalendarEvent/parse. Unlike a CalDAV resource
 * such a file may carry any number of unrelated events.
 */
export function icalToEvents(ics: string): JsEvent[] {
  const byUid = new Map<string, Component[]>();
  for (const v of vevents(ics)) {
    const uid = text(v, "UID") ?? "";
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(v);
  }
  return [...byUid.values()].map((group) => veventsToEvent(group, null, null)!);
}

/**
 * Highest SEQUENCE across a resource's VEVENTs. Overrides can be ahead of the
 * master - mailbox.org bumps an edited override's SEQUENCE but leaves the
 * master's alone - so a rewrite has to start above all of them.
 */
export function highestSequence(ics: string): number {
  return Math.max(0, ...vevents(ics).map((v) => Number(prop(v, "SEQUENCE")?.value ?? 0) || 0));
}

function vevents(ics: string): Component[] {
  return parseComponents(ics)
    .flatMap((c) => c.children)
    .filter((c) => c.type === "VEVENT");
}

function veventsToEvent(vevents: Component[], id: string | null, calendarId: string | null): JsEvent | null {
  const master = vevents.find((v) => !prop(v, "RECURRENCE-ID")) ?? vevents[0];
  if (!master) return null;

  const ev = eventProps(master);
  const tz = (ev.timeZone as string | null) ?? null;
  const overrides: Record<string, unknown> = {};

  for (const ex of master.props.filter((p) => p.name === "EXDATE")) {
    for (const v of ex.value.split(",")) {
      const d = parseDate({ ...ex, value: v });
      if (d) overrides[inZone(d, tz)] = { excluded: true };
    }
  }
  for (const o of vevents) {
    const rid = o === master ? undefined : prop(o, "RECURRENCE-ID");
    const d = rid && parseDate(rid);
    if (!d) continue;
    const full = eventProps(o);
    const patch: Record<string, unknown> = {};
    for (const k of ["start", "duration", "timeZone", "title", "description", "locations", "status"]) {
      if (JSON.stringify(full[k]) !== JSON.stringify(ev[k])) patch[k] = full[k];
    }
    overrides[inZone(d, tz)] = patch;
  }

  const rrule = prop(master, "RRULE");
  return {
    id,
    "@type": "Event",
    calendarIds: calendarId === null ? null : { [calendarId]: true },
    ...ev,
    recurrenceRule: rrule ? parseRRule(rrule.value, tz) : null,
    recurrenceOverrides: Object.keys(overrides).length ? overrides : null,
    excludedRecurrenceRule: null,
    useDefaultAlerts: false,
    isDraft: false,
  };
}

function eventProps(v: Component): JsEvent {
  const start = parseDate(prop(v, "DTSTART"));
  const end = parseDate(prop(v, "DTEND"));
  const allDay = start?.date ?? false;
  const tz = start && !allDay ? start.tz : null;

  let duration = prop(v, "DURATION")?.value ?? null;
  if (!duration) {
    duration = start && end ? formatDuration((utcMs(end) - utcMs(start)) / 1000, allDay) : allDay ? "P1D" : "PT0S";
  }
  const utcStart = start && !allDay ? utcMs(start) : null;

  const location = text(v, "LOCATION");
  const cls = prop(v, "CLASS")?.value.toUpperCase();
  return {
    uid: text(v, "UID") ?? "",
    title: text(v, "SUMMARY") ?? "",
    description: text(v, "DESCRIPTION") ?? "",
    descriptionContentType: "text/plain",
    created: utcStamp(prop(v, "CREATED")),
    updated: utcStamp(prop(v, "LAST-MODIFIED") ?? prop(v, "DTSTAMP")),
    sequence: Number(prop(v, "SEQUENCE")?.value ?? 0) || 0,
    start: start?.local ?? null,
    timeZone: tz,
    showWithoutTime: allDay,
    duration,
    utcStart: utcStart === null ? null : isoUtc(utcStart),
    utcEnd: utcStart === null ? null : isoUtc(utcStart + durationSeconds(duration) * 1000),
    status: (prop(v, "STATUS")?.value.toLowerCase() as string | undefined) ?? "confirmed",
    freeBusyStatus: prop(v, "TRANSP")?.value.toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    privacy: cls === "PRIVATE" ? "private" : cls === "CONFIDENTIAL" ? "secret" : "public",
    locations: location ? { "1": { "@type": "Location", name: location } } : null,
    participants: participants(v),
    alerts: alerts(v),
  };
}

function participants(v: Component): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const p of v.props) {
    if (p.name !== "ORGANIZER" && p.name !== "ATTENDEE") continue;
    const email = p.value.replace(/^mailto:/i, "");
    const roles: Record<string, boolean> = p.name === "ORGANIZER" ? { owner: true } : { attendee: true };
    out[`p${++n}`] = {
      "@type": "Participant",
      name: p.params.CN?.[0] ?? null,
      email,
      calendarAddress: `mailto:${email}`,
      roles,
      participationStatus: p.params.PARTSTAT?.[0]?.toLowerCase() ?? (p.name === "ORGANIZER" ? "accepted" : "needs-action"),
    };
  }
  return n ? out : null;
}

function alerts(v: Component): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const a of v.children) {
    const t = a.type === "VALARM" ? prop(a, "TRIGGER") : undefined;
    if (!t) continue;
    const abs = t.params.VALUE?.[0]?.toUpperCase() === "DATE-TIME";
    out[`a${++n}`] = {
      "@type": "Alert",
      trigger: abs
        ? { "@type": "AbsoluteTrigger", when: utcStamp(t) }
        : { "@type": "OffsetTrigger", offset: t.value, relativeTo: t.params.RELATED?.[0]?.toUpperCase() === "END" ? "end" : "start" },
      action: prop(a, "ACTION")?.value.toUpperCase() === "EMAIL" ? "email" : "display",
      acknowledged: null,
      relatedTo: null,
    };
  }
  return n ? out : null;
}

// -- RRULE ---------------------------------------------------------------------

export function parseRRule(value: string, tz: string | null): Record<string, unknown> {
  const parts = Object.fromEntries(
    value.split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)];
    }),
  );
  const nums = (k: string) => (parts[k] ? String(parts[k]).split(",").map(Number) : null);
  const until = parts.UNTIL ? parseDate({ name: "UNTIL", params: {}, value: parts.UNTIL }) : null;
  return {
    "@type": "RecurrenceRule",
    frequency: String(parts.FREQ ?? "DAILY").toLowerCase(),
    interval: Number(parts.INTERVAL ?? 1),
    firstDayOfWeek: String(parts.WKST ?? "MO").toLowerCase(),
    byDay: parts.BYDAY
      ? String(parts.BYDAY).split(",").map((d) => {
          const m = /^([+-]?\d+)?([A-Z]{2})$/i.exec(d.trim());
          const day = (m?.[2] ?? d).toLowerCase();
          return m?.[1] ? { "@type": "NDay", day, nthOfPeriod: Number(m[1]) } : { "@type": "NDay", day };
        })
      : null,
    byMonthDay: nums("BYMONTHDAY"),
    byMonth: parts.BYMONTH ? String(parts.BYMONTH).split(",") : null,
    byYearDay: nums("BYYEARDAY"),
    byWeekNo: nums("BYWEEKNO"),
    byHour: nums("BYHOUR"),
    byMinute: nums("BYMINUTE"),
    bySecond: nums("BYSECOND"),
    bySetPosition: nums("BYSETPOS"),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    // A date-only UNTIL is inclusive of that whole day.
    until: until ? (until.date ? until.local.slice(0, 10) + "T23:59:59" : inZone(until, tz)) : null,
  };
}

// -- dates & time zones ----------------------------------------------------------

interface IcalDate {
  /** Wall-clock LocalDateTime, "YYYY-MM-DDTHH:MM:SS". */
  local: string;
  /** IANA zone, "Etc/UTC" for a Z value, null for floating or date-only. */
  tz: string | null;
  date: boolean;
}

function parseDate(p: ParsedLine | undefined): IcalDate | null {
  const m = p && /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!p || !m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  if (!m[4]) return { local, tz: null, date: true };
  if (m[7]) return { local, tz: "Etc/UTC", date: false };
  const tzid = p.params.TZID?.[0];
  // A TZID that isn't an IANA name (Outlook's "W. Europe Standard Time") is
  // treated as floating time. Resolving it would mean evaluating the
  // resource's VTIMEZONE, which we don't do yet.
  return { local, tz: tzid && validZone(tzid) ? tzid : null, date: false };
}

/** The date's wall clock in `tz` (unchanged when either side is floating). */
function inZone(d: IcalDate, tz: string | null): string {
  if (!tz || !d.tz || d.tz === tz || d.date) return d.local;
  return utcToLocal(utcMs(d), tz);
}

function utcMs(d: IcalDate): number {
  return localToUtc(d.local, d.tz ?? "Etc/UTC");
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function utcToLocal(ms: number, tz: string): string {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Instant at which the wall clock in `tz` reads `local`. */
export function localToUtc(local: string, tz: string): number {
  const naive = Date.parse(local + "Z");
  const offsetAt = (t: number) => Date.parse(utcToLocal(t, tz) + "Z") - t;
  // Second pass settles instants near a DST switch.
  return naive - offsetAt(naive - offsetAt(naive));
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function utcStamp(p: ParsedLine | undefined): string | null {
  const d = parseDate(p);
  return d ? isoUtc(utcMs(d)) : null;
}

function formatDuration(seconds: number, allDay: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (allDay || (s > 0 && s % 86400 === 0)) return `P${Math.max(1, Math.round(s / 86400))}D`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const time = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${r ? `${r}S` : ""}`;
  return `P${d ? `${d}D` : ""}${time ? `T${time}` : d ? "" : "T0S"}`;
}

function durationSeconds(d: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return 0;
  const [, sign, w, dd, h, mi, s] = m.map((x) => x ?? "0");
  const total = ((Number(w) * 7 + Number(dd)) * 24 + Number(h)) * 3600 + Number(mi) * 60 + Number(s);
  return sign === "-" ? -total : total;
}

function prop(c: Component, name: string): ParsedLine | undefined {
  return c.props.find((p) => p.name === name);
}

function text(c: Component, name: string): string | undefined {
  const p = prop(c, name);
  return p ? unescapeValue(p.value) : undefined;
}

// -- JSCalendar -> iCalendar -------------------------------------------------------

// VEVENT properties eventToIcal writes itself; anything else on an existing
// master event (X-*, URL, ATTACH, CATEGORIES, ...) is carried over verbatim.
const MANAGED = new Set([
  "UID", "DTSTAMP", "DTSTART", "DTEND", "DURATION", "SUMMARY", "DESCRIPTION", "LOCATION", "RRULE",
  "EXDATE", "RDATE", "RECURRENCE-ID", "STATUS", "TRANSP", "CLASS", "CREATED", "LAST-MODIFIED",
  "SEQUENCE", "ORGANIZER", "ATTENDEE",
]);

/**
 * Serialise a JSCalendar Event as a CalDAV resource. `original` is the stored
 * iCalendar body on update: its VTIMEZONEs and unmodelled master properties
 * are kept.
 */
export function eventToIcal(ev: JsEvent, original?: string): string {
  const tz = typeof ev.timeZone === "string" && validZone(ev.timeZone) ? ev.timeZone : null;
  const allDay = ev.showWithoutTime === true;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bulwark//legacy-proxy//EN", "CALSCALE:GREGORIAN"];

  const keptZones = original ? original.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r?\n?/g) ?? [] : [];
  for (const z of keptZones) lines.push(z.replace(/\r?\n$/, ""));
  if (tz && !allDay && !isUtc(tz) && !keptZones.some((z) => new RegExp(`^TZID:${escapeRe(tz)}\\s*$`, "m").test(z))) {
    lines.push(...vtimezone(tz, Number(String(ev.start ?? "").slice(0, 4)) || new Date().getUTCFullYear()));
  }

  const masterOrig = original
    ? parseComponents(original).flatMap((c) => c.children).find((c) => c.type === "VEVENT" && !prop(c, "RECURRENCE-ID"))
    : undefined;
  const extra = masterOrig ? masterOrig.props.filter((p) => !MANAGED.has(p.name)).map(rawLine) : [];

  const overrides = (ev.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>;
  const exdates = Object.entries(overrides).filter(([, o]) => o.excluded).map(([k]) => dateLine("EXDATE", k, tz, allDay));
  lines.push(...vevent(ev, tz, allDay, [...(ev.recurrenceRule ? [`RRULE:${rruleString(ev.recurrenceRule as Record<string, unknown>, tz, allDay)}`] : []), ...exdates, ...extra]));

  const base: JsEvent = { ...ev, recurrenceRule: null, recurrenceOverrides: null };
  for (const [key, patch] of Object.entries(overrides)) {
    if (patch.excluded) continue;
    const o = structuredClone(base);
    applyPatch(o, patch);
    const oTz = typeof o.timeZone === "string" && validZone(o.timeZone) ? o.timeZone : null;
    lines.push(...vevent(o, oTz, o.showWithoutTime === true, [], dateLine("RECURRENCE-ID", key, tz, allDay)));
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function vevent(e: JsEvent, tz: string | null, allDay: boolean, extra: string[], recurrenceId?: string): string[] {
  const start = String(e.start ?? "");
  const out = ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${compactUtc(Date.now())}`];
  if (recurrenceId) out.push(recurrenceId);
  out.push(dateLine("DTSTART", start, tz, allDay));
  out.push(dateLine("DTEND", addSeconds(start, durationSeconds(String(e.duration ?? (allDay ? "P1D" : "PT0S"))), tz, allDay), tz, allDay));
  if (e.title) out.push(`SUMMARY:${escapeValue(String(e.title))}`);
  if (e.description) out.push(`DESCRIPTION:${escapeValue(String(e.description))}`);
  const loc = Object.values((e.locations ?? {}) as Record<string, { name?: string }>).find((l) => l?.name)?.name;
  if (loc) out.push(`LOCATION:${escapeValue(loc)}`);
  if (typeof e.status === "string") out.push(`STATUS:${e.status.toUpperCase()}`);
  out.push(`TRANSP:${e.freeBusyStatus === "free" ? "TRANSPARENT" : "OPAQUE"}`);
  out.push(`CLASS:${e.privacy === "private" ? "PRIVATE" : e.privacy === "secret" ? "CONFIDENTIAL" : "PUBLIC"}`);
  out.push(`SEQUENCE:${Number(e.sequence ?? 0) || 0}`);
  if (typeof e.created === "string") out.push(`CREATED:${compactUtc(Date.parse(e.created))}`);
  out.push(`LAST-MODIFIED:${compactUtc(Date.now())}`);
  out.push(...extra);

  for (const p of Object.values((e.participants ?? {}) as Record<string, Record<string, unknown>>)) {
    const send = (p.sendTo as Record<string, string> | undefined)?.imip;
    const addr = String(p.email ?? send ?? p.calendarAddress ?? "").replace(/^mailto:/i, "");
    if (!addr) continue;
    const cn = p.name ? `;CN=${quoteParam(String(p.name))}` : "";
    const roles = (p.roles ?? {}) as Record<string, boolean>;
    if (roles.owner) out.push(`ORGANIZER${cn}:mailto:${addr}`);
    if (!roles.owner || roles.attendee) {
      const stat = typeof p.participationStatus === "string" ? p.participationStatus.toUpperCase() : "NEEDS-ACTION";
      out.push(`ATTENDEE${cn};PARTSTAT=${stat}:mailto:${addr}`);
    }
  }

  for (const a of Object.values((e.alerts ?? {}) as Record<string, { trigger?: Record<string, string> }>)) {
    const t = a?.trigger;
    if (!t) continue;
    const trigger = t["@type"] === "AbsoluteTrigger" && t.when
      ? `TRIGGER;VALUE=DATE-TIME:${compactUtc(Date.parse(t.when))}`
      : `TRIGGER${t.relativeTo === "end" ? ";RELATED=END" : ""}:${t.offset ?? "PT0S"}`;
    // EMAIL alarms need ATTENDEE / SUMMARY lines of their own (RFC 5545
    // §3.6.6), so every alert is written as a DISPLAY alarm.
    out.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeValue(String(e.title || "Reminder"))}`, trigger, "END:VALARM");
  }
  out.push("END:VEVENT");
  return out;
}

function rruleString(r: Record<string, unknown>, tz: string | null, allDay: boolean): string {
  const parts = [`FREQ=${String(r.frequency ?? "daily").toUpperCase()}`];
  if (r.interval && r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (typeof r.until === "string") {
    const until = r.until.slice(0, 19);
    parts.push(`UNTIL=${allDay ? until.slice(0, 10).replace(/-/g, "") : compactUtc(localToUtc(until, tz ?? "Etc/UTC"))}`);
  }
  const days = r.byDay as Array<{ day: string; nthOfPeriod?: number }> | null | undefined;
  if (days?.length) parts.push(`BYDAY=${days.map((d) => `${d.nthOfPeriod ?? ""}${d.day.toUpperCase()}`).join(",")}`);
  const lists: Array<[string, string]> = [
    ["byMonthDay", "BYMONTHDAY"], ["byMonth", "BYMONTH"], ["byYearDay", "BYYEARDAY"], ["byWeekNo", "BYWEEKNO"],
    ["byHour", "BYHOUR"], ["byMinute", "BYMINUTE"], ["bySecond", "BYSECOND"], ["bySetPosition", "BYSETPOS"],
  ];
  for (const [k, name] of lists) {
    const v = r[k] as unknown[] | null | undefined;
    if (v?.length) parts.push(`${name}=${v.join(",")}`);
  }
  if (typeof r.firstDayOfWeek === "string" && r.firstDayOfWeek !== "mo") parts.push(`WKST=${r.firstDayOfWeek.toUpperCase()}`);
  return parts.join(";");
}

function dateLine(name: string, local: string, tz: string | null, allDay: boolean): string {
  const compact = local.slice(0, 19).replace(/[-:]/g, "");
  if (allDay) return `${name};VALUE=DATE:${compact.slice(0, 8)}`;
  if (tz && isUtc(tz)) return `${name}:${compact}Z`;
  return tz ? `${name};TZID=${tz}:${compact}` : `${name}:${compact}`;
}

function addSeconds(local: string, secs: number, tz: string | null, allDay: boolean): string {
  const l = local.slice(0, 19);
  if (allDay || !tz) return new Date(Date.parse(l + "Z") + secs * 1000).toISOString().slice(0, 19);
  return utcToLocal(localToUtc(l, tz) + secs * 1000, tz);
}

/**
 * Build a VTIMEZONE for `tz` from the platform's zone data, describing the
 * given year's transitions as yearly "nth / last weekday of the month" rules.
 * That holds for the EU and US zones; for anything more irregular the block
 * is only approximate, but it still carries the IANA TZID, which CalDAV
 * servers resolve on their own.
 */
function vtimezone(tz: string, year: number): string[] {
  const off = (ms: number) => Math.round((Date.parse(utcToLocal(ms, tz) + "Z") - ms) / 60_000);
  const fmtOff = (m: number) => `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}${String(Math.abs(m) % 60).padStart(2, "0")}`;
  const out = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  let prev = off(from);
  let found = false;
  for (let t = from + 3_600_000; t < to; t += 3_600_000) {
    const o = off(t);
    if (o === prev) continue;
    const wall = new Date(t + prev * 60_000);
    const day = wall.getUTCDate();
    const dim = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
    const nth = day + 7 > dim ? -1 : Math.ceil(day / 7);
    const wd = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][wall.getUTCDay()];
    const kind = o > prev ? "DAYLIGHT" : "STANDARD";
    out.push(`BEGIN:${kind}`, `DTSTART:${wall.toISOString().slice(0, 19).replace(/[-:]/g, "")}`,
      `TZOFFSETFROM:${fmtOff(prev)}`, `TZOFFSETTO:${fmtOff(o)}`,
      `RRULE:FREQ=YEARLY;BYMONTH=${wall.getUTCMonth() + 1};BYDAY=${nth}${wd}`, `END:${kind}`);
    prev = o;
    found = true;
  }
  if (!found) {
    out.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${fmtOff(prev)}`, `TZOFFSETTO:${fmtOff(prev)}`, "END:STANDARD");
  }
  out.push("END:VTIMEZONE");
  return out;
}

function isUtc(tz: string): boolean {
  return tz === "UTC" || tz === "Etc/UTC";
}

function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function rawLine(p: ParsedLine): string {
  const params = Object.entries(p.params).map(([k, vs]) => `;${k}=${vs.map(quoteParam).join(",")}`).join("");
  return `${p.name}${params}:${p.value}`;
}

function quoteParam(v: string): string {
  return /[:;,]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
