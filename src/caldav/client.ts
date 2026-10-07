// Minimal read-only CalDAV client (RFC 4791). Discovery, auth and transport are
// the CardDAV client's (same WebDAV underneath); this adds the calendar
// collection listing and the two REPORTs JMAP for Calendars needs.

import { CardDavClient, extractHref, hasResourceType, splitResponses, textOf, type CardDavOpts } from "../carddav/client.js";

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

export class CalDavClient extends CardDavClient {
  constructor(opts: Omit<CardDavOpts, "caldav">) {
    super({ ...opts, caldav: true });
  }

  async listCalendars(): Promise<CalendarInfo[]> {
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
    return splitResponses(xml).map(extractHref).filter((h): h is string => !!h && h !== calHref);
  }

  async multiGetEvents(calHref: string, hrefs: string[]): Promise<ICalResource[]> {
    if (hrefs.length === 0) return [];
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:calendar-multiget ${CAL_NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>` +
      hrefs.map((h) => `<D:href>${h.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</D:href>`).join("") +
      `</C:calendar-multiget>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    const out: ICalResource[] = [];
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      const data = textOf(r, "calendar-data");
      if (href && data) out.push({ href, etag: textOf(r, "getetag"), data });
    }
    return out;
  }
}

function caldavTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
