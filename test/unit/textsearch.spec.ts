// A full-text search asks the server to read as few messages as possible, in
// small steps, and does not lose what it learned when its time runs out.

import { afterAll, beforeEach, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";
import { matchesText, resetTextSearch, searchText, splitTextFilter, TextSearchStalled, type MessageText } from "../../src/imap/textsearch.js";

process.env.LOG_LEVEL = "silent";
process.env.IMAP_TEXT_STEP_TIMEOUT_MS = "150";
process.env.IMAP_TEXT_READ_MAX = "10";
afterAll(() => { delete process.env.IMAP_TEXT_STEP_TIMEOUT_MS; delete process.env.IMAP_TEXT_READ_MAX; });
beforeEach(() => resetTextSearch());

const expand = (set: string) =>
  set.split(",").flatMap((p) => {
    const [a, b = a] = p.split(":").map(Number) as [number, number?];
    return Array.from({ length: b! - a + 1 }, (_, i) => a + i);
  });

/** Messages 1..count; the text of every tenth matches. `delay` per message read. */
function server(count: number, delay = 0) {
  const c = {
    usable: true,
    closed: false,
    mailbox: { path: "Archive", exists: count },
    cheap: [] as unknown[],
    read: [] as number[],
    close: () => { c.closed = true; c.usable = false; },
    search: async (q: { uid?: string; since?: Date }) => {
      if (q.uid === undefined) {
        c.cheap.push(q);
        return Array.from({ length: count }, (_, i) => i + 1).filter((u) => !q.since || u > count / 2);
      }
      const uids = expand(q.uid);
      if (delay) await new Promise((r) => setTimeout(r, delay * uids.length));
      c.read.push(...uids);
      return uids.filter((u) => u % 10 === 0);
    },
  };
  return c;
}
const run = (c: ReturnType<typeof server>, filter: unknown, more: object = {}) =>
  searchText(c as unknown as ImapFlow, { filter: filter as never, until: Date.now() + 5_000, folderKey: "f", ...more });

it("reads only what the other criteria and the cache leave", async () => {
  const c = server(1000);
  const filter = { operator: "AND", conditions: [{ body: "word" }, { after: "2026-11-01T00:00:00Z" }, { hasAttachment: true }, { inMailbox: "x" }] };
  const found = await run(c, filter, { narrow: (uids: number[]) => uids.filter((u) => u % 2 === 0) });
  expect(c.cheap).toEqual([{ since: new Date("2026-11-01T00:00:00Z") }]);
  expect(c.read).toHaveLength(250);
  expect(found).toEqual(Array.from({ length: 50 }, (_, i) => 510 + i * 10));
});

it("reads the newest messages first, in steps", async () => {
  const c = server(300);
  expect(await run(c, { text: "word" })).toHaveLength(30);
  expect(c.read.slice(0, 50).sort((a, b) => a - b)[0]).toBe(251);
  expect(new Set(c.read).size).toBe(300);
});

it("goes on where a search ended that ran out of time", async () => {
  const slow = server(300, 2);
  await expect(run(slow, { text: "word" }, { until: Date.now() + 350 })).rejects.toMatchObject({ type: "serverUnavailable" });
  const before = slow.read.length;
  expect(before).toBeGreaterThanOrEqual(50);
  const c = server(300);
  expect(await run(c, { text: "word" })).toHaveLength(30);
  expect(c.read.length).toBeLessThan(300);
  // Nothing left to read, and other words start anew.
  const again = server(300);
  expect(await run(again, { text: "word" })).toHaveLength(30);
  expect(again.read).toEqual([]);
  await run(again, { text: "other" });
  expect(again.read).toHaveLength(300);
});

it("leaves an OR or NOT with text to one SEARCH", async () => {
  expect(splitTextFilter({ operator: "OR", conditions: [{ text: "a" }, { from: "b" }] })).toBeNull();
  expect(await run(server(10), { operator: "AND", conditions: [{ inMailbox: "x" }, { operator: "NOT", conditions: [{ body: "a" }] }] })).toBeNull();
  // Others stay whole on the side the server answers from its index.
  expect(splitTextFilter({ operator: "AND", conditions: [{ text: "a" }, { operator: "OR", conditions: [{ from: "b" }, { to: "c" }] }] })).toEqual({
    cheap: [{ operator: "OR", conditions: [{ from: "b" }, { to: "c" }] }],
    text: [{ text: "a" }],
  });
});

/** A server that answers other searches and never one for text. */
function silentServer(count: number) {
  const c = server(count);
  const plain = c.search;
  c.search = async (q: { uid?: string }) => (q.uid === undefined ? plain(q) : new Promise<number[]>(() => {}));
  return c;
}
const reader = (reads: number[][]) => async (_c: unknown, uids: number[]) => {
  reads.push(uids);
  return new Map<number, MessageText>(uids.map((u) => [u, { header: "Subject", body: u % 10 === 0 ? "the WORD here" : "nothing" }]));
};

it("reads the messages itself in a folder whose text the server does not search", async () => {
  const reads: number[][] = [];
  const first = silentServer(100);
  await expect(run(first, { text: "word" }, { read: reader(reads) })).rejects.toBeInstanceOf(TextSearchStalled);
  expect(first.closed).toBe(true);
  // The next try does not ask the server for text again.
  expect(await run(silentServer(100), { text: "word" }, { read: reader(reads) })).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  expect(reads[0]![0]).toBe(100);
  expect(reads.flat()).toHaveLength(100);
  // Another folder is asked.
  const other = server(20);
  expect(await run(other, { text: "word" }, { read: reader(reads), folderKey: "g" })).toEqual([10, 20]);
  expect(other.read).toHaveLength(20);
});

it("fails, and remembers nothing, when the messages cannot be read", async () => {
  const none = async () => new Map<number, MessageText>();
  await expect(run(silentServer(20), { text: "word" }, { read: none })).rejects.toBeInstanceOf(TextSearchStalled);
  await expect(run(silentServer(20), { text: "word" }, { read: none })).rejects.toMatchObject({ type: "serverUnavailable" });
  expect(await run(silentServer(20), { text: "word" }, { read: reader([]) })).toEqual([10, 20]);
});

it("matches text in subject, addresses and body, and body in the body alone", () => {
  const m = { header: "Jahresbericht\nMax Müller max@example.org", body: "Der Leistungs-\n nachweis ist da" };
  expect(matchesText([{ text: "JAHRESBERICHT müller" }], m)).toBe(true);
  expect(matchesText([{ text: "max da" }], m)).toBe(true);
  expect(matchesText([{ text: "max fehlt" }], m)).toBe(false);
  expect(matchesText([{ body: "müller" }], m)).toBe(false);
  expect(matchesText([{ body: '"nachweis ist"' }], m)).toBe(true);
  expect(matchesText([{ body: '"ist nachweis"' }], m)).toBe(false);
  expect(matchesText([{ text: "müller" }, { body: "da" }], m)).toBe(true);
});

it("reads a few messages without asking the server for their text", async () => {
  const reads: number[][] = [];
  const c = silentServer(10);
  expect(await run(c, { text: "word" }, { read: reader(reads) })).toEqual([10]);
  expect(c.closed).toBe(false);
  expect(reads.flat()).toHaveLength(10);
});

it("stops asking for an account that left two folders unanswered, but not for another", async () => {
  const read = reader([]);
  for (const folderKey of ["1|a", "1|b"]) await expect(run(silentServer(50), { text: "word" }, { read, folderKey })).rejects.toBeInstanceOf(TextSearchStalled);
  expect(await run(silentServer(50), { text: "word" }, { read, folderKey: "1|c" })).toHaveLength(5);
  await expect(run(silentServer(50), { text: "word" }, { read, folderKey: "2|a" })).rejects.toBeInstanceOf(TextSearchStalled);
});
