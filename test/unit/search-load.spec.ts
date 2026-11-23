// What a search may cost the rest of the account: a full-text search takes one
// connection at a time, stops when its client has gone, and a SEARCH that
// failed never passes for an empty folder.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store, type AccountRow } from "../../src/state/store.js";
import { runAbortable } from "../../src/jmap/abort.js";
import { isReadOnlyRequest } from "../../src/jmap/router.js";
import { emailQuery, resetFolderSearchCache } from "../../src/jmap/methods/email.js";
import { buildThreadIndex } from "../../src/jmap/methods/threads.js";
import { listMailboxes, resetMailboxListCache } from "../../src/jmap/methods/mailbox.js";

process.env.LOG_LEVEL = "silent";

let dir: string;
let store: Store;
let account: AccountRow;
const FOLDERS = ["INBOX", "Archive", "Projects", "Receipts"];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "searchload-"));
  store = new Store(dir);
  resetFolderSearchCache();
  resetMailboxListCache();
  account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeClient(search: (folder: string) => Promise<unknown>) {
  let held: Promise<void> = Promise.resolve();
  const c = {
    usable: true,
    mailbox: false as unknown,
    list: async () =>
      FOLDERS.map((p) => ({ path: p, name: p, delimiter: "/", subscribed: true, status: { messages: 1, unseen: 0, uidNext: 2, uidValidity: 7n } })),
    getMailboxLock: async (p: string) => {
      const prev = held;
      let release!: () => void;
      held = new Promise<void>((r) => (release = r));
      await prev;
      c.mailbox = { path: p, uidValidity: 7n, uidNext: 2, exists: 1 };
      return { release };
    },
    noop: async () => {},
    search: async () => search((c.mailbox as { path: string }).path),
    fetch: async function* () { yield { uid: 1, internalDate: new Date(0) }; },
  };
  return c as unknown as ImapFlow & { usable: boolean };
}

/** A pool whose bulk connections are counted; every lease gets its own client. */
function countingPool(search: (folder: string) => Promise<unknown>) {
  const p = {
    busy: 0,
    most: 0,
    withConnection: async (_a: unknown, _r: string, fn: (c: ImapFlow) => Promise<unknown>) => {
      p.most = Math.max(p.most, ++p.busy);
      try {
        return await fn(makeClient(search));
      } finally {
        p.busy--;
      }
    },
  };
  return p;
}
const slow = () => new Promise((r) => setTimeout(() => r([1]), 10));
const query = (filter: unknown, client: ImapFlow, pool?: unknown) =>
  emailQuery({ accountId: String(account.id), filter } as never, { account, client, store, pool } as never);

it("gives full-text searches one connection at a time, also several of them", async () => {
  const pool = countingPool(slow);
  const c = makeClient(slow);
  const [a, b] = await Promise.all([query({ text: "invoice" }, c, pool), query({ operator: "AND", conditions: [{ text: "other" }] }, c, pool)]);
  expect([a.total, b.total]).toEqual([4, 4]);
  expect(pool.most).toBe(1);
});

it("still scans folders side by side for a keyword", async () => {
  const pool = countingPool(slow);
  expect((await query({ hasKeyword: "$label:x" }, makeClient(slow), pool)).total).toBe(4);
  expect(pool.most).toBeGreaterThan(1);
});

it("goes on with the next search after one failed", async () => {
  const bad = countingPool(async () => { throw Object.assign(new Error("gone"), { code: "NoConnection" }); });
  await expect(query({ text: "one" }, makeClient(slow), bad)).rejects.toThrow("gone");
  expect((await query({ text: "two" }, makeClient(slow), countingPool(slow))).total).toBe(4);
});

it("stops searching once the client closed the request", async () => {
  const gone = new AbortController();
  const searched: string[] = [];
  const pool = countingPool(async (f) => {
    searched.push(f);
    gone.abort();
    return [1];
  });
  await expect(runAbortable(gone.signal, () => query({ text: "x" }, makeClient(slow), pool))).rejects.toMatchObject({ type: "serverUnavailable" });
  expect(searched).toHaveLength(1);
});

it("gives up only requests that change nothing", () => {
  const env = (...names: string[]) => ({ using: [], methodCalls: names.map((n, i) => [n, {}, String(i)]) }) as never;
  expect(isReadOnlyRequest(env("Email/query", "Email/get", "Thread/get"))).toBe(true);
  expect(isReadOnlyRequest(env("Email/query", "Email/set"))).toBe(false);
});

it("does not take a failed SEARCH for an empty folder, nor remember it", async () => {
  let answer: unknown = false;
  const c = makeClient(async () => answer);
  const inMailbox = (await listMailboxes(c, account, store)).find((m) => m.name === "INBOX")!.id;
  await expect(query({ inMailbox }, c)).rejects.toMatchObject({ type: "serverFail" });
  answer = [1];
  expect((await query({ inMailbox }, c)).total).toBe(1);
});

it("leaves out one folder that refuses the SEARCH, and fails when all do", async () => {
  expect((await query({ text: "refused once" }, makeClient(async (f) => (f === "Archive" ? false : [1])))).total).toBe(3);
  resetFolderSearchCache();
  await expect(query({ text: "refused everywhere" }, makeClient(async () => false))).rejects.toMatchObject({ type: "serverFail" });
});

it("keeps the cached messages of a folder whose SEARCH failed", async () => {
  const c = makeClient(async () => false);
  const id = store.db.prepare("SELECT id FROM mailbox WHERE name = 'INBOX'");
  await listMailboxes(c, account, store);
  const mailboxId = (id.get() as { id: number }).id;
  store.upsertEmailCacheRows([1, 2].map((uid) => ({ accountId: account.id, mailboxId, uidvalidity: 7, uid, threadId: "t", internaldate: 1 })));
  store.putMailboxScan({ account_id: account.id, mailbox_id: mailboxId, uidvalidity: 7, uidnext: 2, messages: 2, scanned_at: 1 });
  await buildThreadIndex({ account, client: c, store } as never);
  expect(store.getEmailCacheUids(account.id, mailboxId)).toEqual([1, 2]);
});
