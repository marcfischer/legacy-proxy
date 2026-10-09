// End-to-end tests for Calendar/get and CalendarEvent/query, /get and /set
// against a fake CalDAV server on globalThis.fetch, logging in with the
// provider's own DAV credentials rather than the mail ones. CalendarEvent/parse
// reads blobs, not CalDAV, so it gets a fake store and IMAP pool instead.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { calendarEventGet, calendarEventParse, calendarEventQuery, calendarEventSet, calendarGet, type CalendarCtx } from "../../src/jmap/methods/calendars.js";
import { resetCardDavCaches } from "../../src/carddav/client.js";
import { resetCalDavCaches } from "../../src/caldav/client.js";
import { Readable } from "node:stream";
import type { AccountRow, Store } from "../../src/state/store.js";
import type { ImapPool } from "../../src/imap/pool.js";
import { encodeBlobId, encodeEmailId } from "../../src/mapping/ids.js";
import type { ProviderConfig } from "../../src/util/config.js";

const EVENT = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261007T120000Z\r\nDTEND:20261007T130000Z\r\nSUMMARY:Lunch & talk\r\nEND:VEVENT\r\nEND:VCALENDAR";
const ms = (body: string) =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`, { status: 207 });

let reports: string[] = [];
let store = new Map<string, { data: string; etag: string }>();
let etagSeq = 1;
// Like real servers, answer with percent-encoded hrefs (`@` -> `%40`).
const resp = (href: string, r: { data: string; etag: string }) =>
  `<D:response><D:href>${href.replace(/@/g, "%40")}</D:href><D:propstat><D:prop><D:getetag>${r.etag}</D:getetag><C:calendar-data>${r.data.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</C:calendar-data></D:prop></D:propstat></D:response>`;

beforeEach(() => {
  resetCardDavCaches();
  resetCalDavCaches();
  reports = [];
  store = new Map([["/cal/u/work/1.ics", { data: EVENT, etag: `"1"` }]]);
  etagSeq = 1;
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
      const wanted = body.includes("calendar-multiget") ? [...body.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => decodeURIComponent(m[1]!)) : [...store.keys()];
      return ms(wanted.filter((h) => store.has(h)).map((h) => resp(h, store.get(h)!)).join(""));
    }
    const headers = init.headers as Record<string, string>;
    if (init.method === "PUT") {
      const existing = store.get(path);
      if (headers["If-None-Match"] === "*" && existing) return new Response("", { status: 412 });
      if (headers["If-Match"] && headers["If-Match"] !== existing?.etag) return new Response("", { status: 412 });
      const etag = `"${++etagSeq}"`;
      store.set(path, { data: body, etag });
      return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
    }
    if (init.method === "DELETE") return new Response(null, { status: store.delete(path) ? 204 : 404 });
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

it("creates, updates (incl. a single occurrence) and destroys events", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  const calId = (await calendarGet({ accountId: "1" }, ctx)).list[0]!.id;

  const created = await calendarEventSet({
    accountId: "1",
    create: {
      n1: {
        calendarIds: { [calId]: true }, uid: "standup@example.org", title: "Standup", start: "2026-10-05T09:00:00", timeZone: "Europe/Berlin", duration: "PT15M",
        recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ day: "mo" }] },
      },
    },
  }, ctx);
  const id = created.created!.n1!.id;
  const ics = store.get("/cal/u/work/" + created.created!.n1!.uid + ".ics")!.data;
  expect(ics).toContain("DTSTART;TZID=Europe/Berlin:20261005T090000");
  expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  expect(ics).toMatch(/BEGIN:DAYLIGHT[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/);

  // Move one occurrence, then the whole series' title; both are patches on the base event.
  const upd = await calendarEventSet({ accountId: "1", update: {
    [id]: { "recurrenceOverrides/2026-10-12T09:00:00": { start: "2026-10-12T11:00:00" } },
  } }, ctx);
  expect(upd.updated).toEqual({ [id]: null });
  // The server may bump an override's SEQUENCE past the master's; the next
  // write must not take it back down.
  const href = "/cal/u/work/standup@example.org.ics";
  const stored = store.get(href)!;
  store.set(href, { ...stored, data: stored.data.replace(/(RECURRENCE-ID[\s\S]*?)SEQUENCE:1/, "$1SEQUENCE:5") });
  await calendarEventSet({ accountId: "1", update: { [id]: { title: "Daily" } } }, ctx);
  expect([...store.get(href)!.data.matchAll(/SEQUENCE:(\d+)/g)].map((m) => m[1])).toEqual(["6", "6"]);
  const [ev] = (await calendarEventGet({ accountId: "1", ids: [id] }, ctx)).list;
  expect(ev).toMatchObject({
    title: "Daily",
    sequence: 6,
    recurrenceOverrides: { "2026-10-12T09:00:00": { start: "2026-10-12T11:00:00" } },
  });

  // Bulwark's synthetic-id probe must not look like a supported id.
  const probe = await calendarEventSet({ accountId: "1", update: { h333333: {} } }, ctx);
  expect(probe.notUpdated!.h333333!.type).toBe("invalidProperties");

  const del = await calendarEventSet({ accountId: "1", destroy: [id] }, ctx);
  expect(del.destroyed).toEqual([id]);
  expect([...store.keys()]).toEqual(["/cal/u/work/1.ics"]);
});

it("parses uploaded .ics files and invitation parts, reporting unknown or event-less blobs", async () => {
  const uploads = new Map([
    ["Uics", Buffer.from(EVENT)],
    ["Utodo", Buffer.from("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR")],
  ]);
  const invite = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 7, uidvalidity: 1, uid: 42 }), "2");
  const gone = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 9, uidvalidity: 1, uid: 1 }), "2");
  const fakeStore = {
    getUpload: (id: string, accountId: number) => (accountId === 1 && uploads.has(id) ? { ctype: "text/calendar", body: uploads.get(id)! } : null),
    getCachedBlob: () => null,
    prep: () => ({ get: (mailboxIdx: number) => (mailboxIdx === 7 ? { id: 7, name: "INBOX" } : undefined) }),
  } as unknown as Store;
  const downloads: unknown[][] = [];
  const fakeClient = {
    getMailboxLock: async () => ({ release: () => {} }),
    download: async (...a: unknown[]) => {
      downloads.push(a);
      return { content: Readable.from([Buffer.from(EVENT)]) };
    },
  };
  const fakePool = { withConnection: (_a: unknown, _r: unknown, fn: (c: unknown) => unknown) => fn(fakeClient) } as unknown as ImapPool;
  const ctx = { account: { id: 1 } as AccountRow, store: fakeStore, pool: fakePool };

  const res = await calendarEventParse({ accountId: "1", blobIds: ["Uics", invite, "Utodo", "Umissing", gone, "garbage"] }, ctx);
  expect(res.parsed.Uics).toHaveLength(1);
  expect(res.parsed.Uics![0]).toMatchObject({ uid: "u1", title: "Lunch & talk", utcStart: "2026-10-07T12:00:00Z", duration: "PT1H" });
  expect(res.parsed[invite]![0]).toMatchObject({ uid: "u1" });
  expect(downloads).toEqual([["42", "2", { uid: true }]]);
  expect(res.notParsable).toEqual(["Utodo"]);
  expect(res.notFound).toEqual(["Umissing", gone, "garbage"]);
  await expect(calendarEventParse({ accountId: "2", blobIds: [] }, ctx)).rejects.toThrow();
});
