// A full-text search asks the server to read as few messages as possible, in
// small steps, and does not lose what it learned when its time runs out.

import { beforeEach, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";
import { resetTextSearch, searchText, splitTextFilter } from "../../src/imap/textsearch.js";

process.env.LOG_LEVEL = "silent";
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
