// iCalendar (RFC 5545) -> JSCalendar (RFC 8984) for JMAP for Calendars.
// Read-only: one CalDAV resource (a master VEVENT plus any RECURRENCE-ID
// overrides) becomes one JSCalendar Event. Recurrences are passed through as
// rules, not expanded - the client expands them itself.

import { parseLine, unescapeValue, unfold, type ParsedLine } from "../carddav/vcard.js";

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
  const vevents = parseComponents(text)
    .flatMap((c) => c.children)
    .filter((c) => c.type === "VEVENT");
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
    calendarIds: { [calendarId]: true },
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
  // ponytail: non-IANA TZIDs (Outlook's "W. Europe Standard Time") fall back to
  // floating time; map them via the VTIMEZONE block if such events show up shifted.
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
