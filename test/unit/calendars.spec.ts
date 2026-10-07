// End-to-end read path (Calendar/get -> CalendarEvent/query -> CalendarEvent/get)
// against a fake CalDAV server on globalThis.fetch, logging in with the
// provider's own DAV credentials rather than the mail ones.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { calendarEventGet, calendarEventQuery, calendarGet, type CalendarCtx } from "../../src/jmap/methods/calendars.js";
import { resetCardDavCaches } from "../../src/carddav/client.js";
import { resetCalDavCaches } from "../../src/caldav/client.js";
import type { AccountRow } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

const EVENT = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261007T120000Z\r\nDTEND:20261007T130000Z\r\nSUMMARY:Lunch &amp; talk\r\nEND:VEVENT\r\nEND:VCALENDAR";
const ms = (body: string) =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`, { status: 207 });

let reports: string[] = [];

beforeEach(() => {
  resetCardDavCaches();
  resetCalDavCaches();
  reports = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== "Basic " + Buffer.from("dav-user:dav-pw").toString("base64")) return new Response("", { status: 401 });
    const path = new URL(url).pathname;
    const body = String(init.body ?? "");
    if (init.method === "PROPFIND" && path === "/.well-known/caldav") return new Response("", { status: 301, headers: { location: "/dav/" } });
    if (init.method === "PROPFIND" && path === "/dav/" && body.includes("current-user-principal"))
      return ms(`<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/p/u/</D:href></D:current-user-principal></D:prop></D:propstat></D:response>`);
    if (init.method === "PROPFIND" && path === "/dav/") return ms(`<D:response><D:href>/dav/</D:href></D:response>`);
    if (init.method === "PROPFIND" && path === "/p/u/")
      return ms(`<D:response><D:href>/p/u/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/cal/u/</D:href></C:calendar-home-set></D:prop></D:propstat></D:response>`);
    if (init.method === "PROPFIND" && path === "/cal/u/")
      return ms(
        `<D:response><D:href>/cal/u/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>` +
        `<D:response><D:href>/cal/u/proxy/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar-proxy-read/></D:resourcetype></D:prop></D:propstat></D:response>` +
        `<D:response><D:href>/cal/u/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><x:calendar-color xmlns:x="http://apple.com/ns/ical/">#FF0000FF</x:calendar-color></D:prop></D:propstat></D:response>`,
      );
    if (init.method === "REPORT") {
      reports.push(body);
      return ms(`<D:response><D:href>/cal/u/work/1.ics</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag><C:calendar-data>${EVENT}</C:calendar-data></D:prop></D:propstat></D:response>`);
    }
    return new Response("", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

it("lists calendars and reads events in a time range with separate DAV credentials", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };

  const cals = await calendarGet({ accountId: "1" }, ctx);
  expect(cals.list).toMatchObject([{ name: "Work", color: "#FF0000", isDefault: true }]);

  const q = await calendarEventQuery(
    { accountId: "1", filter: { inCalendars: [cals.list[0]!.id], after: "2026-10-01T00:00:00", before: "2026-11-01T00:00:00" }, timeZone: "Europe/Berlin" },
    ctx,
  );
  expect(q.total).toBe(1);
  // Berlin midnight on 1 Oct is 22:00 UTC the day before.
  expect(reports[0]).toContain(`start="20260930T220000Z" end="20261031T230000Z"`);

  const got = await calendarEventGet({ accountId: "1", ids: [...q.ids, "bogus"] }, ctx);
  expect(got.list).toMatchObject([{ id: q.ids[0], title: "Lunch & talk", utcStart: "2026-10-07T12:00:00Z", duration: "PT1H" }]);
  expect(got.notFound).toEqual(["bogus"]);

  // A reload within the cache window is served from the etag-keyed body cache.
  const before = reports.length;
  const again = await calendarEventGet({ accountId: "1", ids: q.ids }, ctx);
  expect(again.list).toHaveLength(1);
  expect(reports.length).toBe(before);
});
