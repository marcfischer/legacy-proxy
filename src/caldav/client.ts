// Minimal read-only CalDAV client (RFC 4791). Discovery, auth and transport are
// the CardDAV client's (same WebDAV underneath); this adds the calendar
// collection listing and the two REPORTs JMAP for Calendars needs.

import {
  CardDavClient, cachedBody, extractHref, freshEntry, hasResourceType, rememberVCard, splitResponses, textOf, type CardDavOpts,
} from "../carddav/client.js";
import { mapWithConcurrency } from "../util/concurrency.js";

export interface CalendarInfo {
  href: string;
  displayName: string;
  description: string | null;
  color: string | null;
  ctag: string | null;
}

export interface ICalResource {
  href: string;
  etag: string | null;
  data: string;
}

const CAL_NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;

// Same caching scheme as the CardDAV client. A calendar load is one
// Calendar/get plus a query and several CalendarEvent/get batches, each of
// which needs the calendar list - cache it briefly. Event bodies are keyed by
// etag in the shared body cache; the etags come from the most recent query,
// so a body is never older than that query (bounded by ETAG_TTL_MS).
const calListCache = new Map<string, { cals: CalendarInfo[]; at: number }>();
const etagCache = new Map<string, { etag: string; at: number }>();
const CAL_LIST_TTL_MS = 15_000;
const ETAG_TTL_MS = 60_000;
const MULTIGET_CHUNK = 100;
const MULTIGET_CONCURRENCY = 4;

export function resetCalDavCaches(): void {
  calListCache.clear();
  etagCache.clear();
}

export class CalDavClient extends CardDavClient {
  constructor(opts: Omit<CardDavOpts, "caldav">) {
    super({ ...opts, caldav: true });
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const cached = freshEntry(calListCache.get(this.cacheKey), CAL_LIST_TTL_MS);
    if (cached) return cached.cals;
    const home = await this.addressBookHome(); // calendar-home-set in caldav mode
    const xml = await this.propfind(home, 1, [
      "DAV:resourcetype",
      "DAV:displayname",
      "urn:ietf:params:xml:ns:caldav calendar-description",
      "http://apple.com/ns/ical/ calendar-color",
      "http://calendarserver.org/ns/ getctag",
      "DAV:sync-token",
    ]);
    const out: CalendarInfo[] = [];
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      if (!href || !hasResourceType(r, "calendar")) continue;
      const color = textOf(r, "calendar-color");
      out.push({
        href,
        displayName: textOf(r, "displayname") || decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() ?? href),
        description: textOf(r, "calendar-description") || null,
        // Apple's #RRGGBBAA -> #RRGGBB
        color: color ? color.slice(0, 7) : null,
        ctag: textOf(r, "getctag") ?? textOf(r, "sync-token"),
      });
    }
    calListCache.set(this.cacheKey, { cals: out, at: Date.now() });
    return out;
  }

  /** Hrefs of the VEVENT resources in a calendar, optionally overlapping [after, before) (UTC ms). */
  async queryEvents(calHref: string, range?: { after?: number; before?: number }): Promise<string[]> {
    const tr = range && (range.after !== undefined || range.before !== undefined)
      ? `<C:time-range${range.after !== undefined ? ` start="${caldavTime(range.after)}"` : ""}${range.before !== undefined ? ` end="${caldavTime(range.before)}"` : ""}/>`
      : "";
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:calendar-query ${CAL_NS}><D:prop><D:getetag/></D:prop>` +
      `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${tr}</C:comp-filter></C:comp-filter></C:filter>` +
      `</C:calendar-query>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    const out: string[] = [];
    const now = Date.now();
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      if (!href || href === calHref) continue;
      const etag = textOf(r, "getetag");
      if (etag) etagCache.set(`${this.cacheKey}|${href}`, { etag, at: now });
      out.push(href);
    }
    return out;
  }

  async multiGetEvents(calHref: string, hrefs: string[]): Promise<ICalResource[]> {
    const out: ICalResource[] = [];
    const missing: string[] = [];
    for (const href of hrefs) {
      const etag = freshEntry(etagCache.get(`${this.cacheKey}|${href}`), ETAG_TTL_MS)?.etag;
      const data = etag ? cachedBody(`${this.cacheKey}|${href}|${etag}`) : undefined;
      if (etag && data !== undefined) out.push({ href, etag, data });
      else missing.push(href);
    }
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += MULTIGET_CHUNK) chunks.push(missing.slice(i, i + MULTIGET_CHUNK));
    const fetched = await mapWithConcurrency(chunks, MULTIGET_CONCURRENCY, (c) => this.fetchEvents(calHref, c));
    return out.concat(fetched.flat());
  }

  /** PUT an iCalendar resource; same If-Match / If-None-Match rules as the CardDAV putResource. */
  async putEvent(href: string, ics: string, ifMatch?: string | null): Promise<{ etag: string | null }> {
    this.forget(href);
    return this.putResource(href, ics, { ifMatch, contentType: "text/calendar; charset=utf-8" });
  }

  async deleteEvent(href: string): Promise<void> {
    this.forget(href);
    await this.deleteResource(href);
  }

  // A write changes the calendar's ctag (and so the JMAP state) and the
  // resource's etag, so neither cached value may be served afterwards.
  private forget(href: string): void {
    calListCache.delete(this.cacheKey);
    etagCache.delete(`${this.cacheKey}|${href}`);
  }

  /** Fetch bodies from the server, bypassing the cache (writes need the current etag). */
  async fetchEvents(calHref: string, hrefs: string[]): Promise<ICalResource[]> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:calendar-multiget ${CAL_NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>` +
      hrefs.map((h) => `<D:href>${h.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</D:href>`).join("") +
      `</C:calendar-multiget>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    // Servers may answer with a differently encoded href than we asked for
    // (`%40` for the `@` most invitation UIDs carry, or an absolute URL), and
    // callers look results up by the href they passed in, so hand that back.
    const asked = new Map(hrefs.map((h) => [normalizeHref(h), h]));
    const out: ICalResource[] = [];
    for (const r of splitResponses(xml)) {
      const raw = extractHref(r);
      const href = raw && (asked.get(normalizeHref(raw)) ?? raw);
      const data = textOf(r, "calendar-data");
      if (!href || !data) continue;
      const etag = textOf(r, "getetag");
      if (etag) rememberVCard(`${this.cacheKey}|${href}|${etag}`, data);
      out.push({ href, etag, data });
    }
    return out;
  }
}

function normalizeHref(href: string): string {
  const path = href.replace(/^https?:\/\/[^/]+/i, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function caldavTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
