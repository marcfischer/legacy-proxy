import { describe, expect, it } from "vitest";
import { eventToIcal, icalToEvent, icalToEvents, localToUtc, utcToLocal } from "../../src/caldav/ical.js";

const series = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "DTSTAMP:20261001T080000Z",
  "DTSTART;TZID=Europe/Berlin:20261005T100000",
  "DTEND;TZID=Europe/Berlin:20261005T113000",
  "SUMMARY:Team\\, weekly",
  "LOCATION:Raum 1",
  "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20261130T090000Z",
  "EXDATE:20261012T080000Z",
  "ORGANIZER;CN=Marc:mailto:marc@example.org",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.org",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "RECURRENCE-ID;TZID=Europe/Berlin:20261019T100000",
  "DTSTART;TZID=Europe/Berlin:20261019T140000",
  "DTEND;TZID=Europe/Berlin:20261019T153000",
  "SUMMARY:Team\\, weekly",
  "LOCATION:Raum 1",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("icalToEvent", () => {
  it("maps a recurring zoned event with exclusions, overrides and alerts", () => {
    const ev = icalToEvent(series, "e1", "c1")!;
    expect(ev).toMatchObject({
      id: "e1",
      "@type": "Event",
      uid: "abc-123",
      calendarIds: { c1: true },
      title: "Team, weekly",
      start: "2026-10-05T10:00:00",
      timeZone: "Europe/Berlin",
      duration: "PT1H30M",
      showWithoutTime: false,
      utcStart: "2026-10-05T08:00:00Z",
      utcEnd: "2026-10-05T09:30:00Z",
      locations: { "1": { name: "Raum 1" } },
      recurrenceRule: {
        frequency: "weekly",
        interval: 1,
        byDay: [{ day: "mo" }],
        until: "2026-11-30T10:00:00",
      },
      recurrenceOverrides: {
        "2026-10-12T10:00:00": { excluded: true },
        "2026-10-19T10:00:00": { start: "2026-10-19T14:00:00" },
      },
      alerts: { a1: { trigger: { "@type": "OffsetTrigger", offset: "-PT15M", relativeTo: "start" } } },
    });
    const parts = Object.values(ev.participants as Record<string, { email: string; roles: object }>);
    expect(parts.map((p) => p.email)).toEqual(["marc@example.org", "bob@example.org"]);
    // Override only carries what changed.
    expect(Object.keys((ev.recurrenceOverrides as Record<string, object>)["2026-10-19T10:00:00"]!)).toEqual(["start"]);
  });

  it("maps an all-day event and skips VTODO-only resources", () => {
    const allDay = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261224\nDTEND;VALUE=DATE:20261227\nSUMMARY:Xmas\nEND:VEVENT\nEND:VCALENDAR";
    expect(icalToEvent(allDay, "e", "c")).toMatchObject({
      start: "2026-12-24T00:00:00",
      showWithoutTime: true,
      timeZone: null,
      duration: "P3D",
    });
    expect(icalToEvent("BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:t\nEND:VTODO\nEND:VCALENDAR", "t", "c")).toBeNull();
  });
});

describe("icalToEvents", () => {
  it("returns one event per UID, keeping a series and its overrides together", () => {
    const other = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:xyz\r\nDTSTART;VALUE=DATE:20261224\r\nSUMMARY:Heiligabend\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const evs = icalToEvents(`${series}\r\n${other}`);
    expect(evs.map((e) => e.uid)).toEqual(["abc-123", "xyz"]);
    expect(evs[0]).toMatchObject({ id: null, calendarIds: null, title: "Team, weekly" });
    expect(Object.keys(evs[0]!.recurrenceOverrides as object)).toHaveLength(2);
    expect(evs[1]).toMatchObject({ title: "Heiligabend", showWithoutTime: true });
  });

  it("returns nothing for a file without events", () => {
    expect(icalToEvents("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR")).toEqual([]);
    expect(icalToEvents("not a calendar")).toEqual([]);
  });
});

describe("time zone helpers", () => {
  it("round-trips across a DST switch", () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET in Europe/Berlin.
    const t = localToUtc("2026-10-25T12:00:00", "Europe/Berlin");
    expect(new Date(t).toISOString()).toBe("2026-10-25T11:00:00.000Z");
    expect(utcToLocal(Date.parse("2026-07-01T08:00:00Z"), "Europe/Berlin")).toBe("2026-07-01T10:00:00");
  });
});

describe("eventToIcal", () => {
  it("round-trips an event and keeps what it doesn't model", () => {
    const withExtras = series.replace("SUMMARY:Team\\, weekly\r\n", "SUMMARY:Team\\, weekly\r\nX-OX-REMINDER:keep;me\r\n");
    const ev = icalToEvent(withExtras, "e1", "c1")!;
    const out = eventToIcal(ev, withExtras);
    expect(out).toContain("X-OX-REMINDER:keep;me");
    expect(out.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    const again = icalToEvent(out, "e1", "c1")!;
    for (const k of ["title", "start", "timeZone", "duration", "recurrenceRule", "recurrenceOverrides", "locations", "alerts"]) {
      expect(again[k], k).toEqual(ev[k]);
    }
  });
});
