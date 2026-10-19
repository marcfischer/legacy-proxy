import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { emailQuery } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";

const dir = mkdtempSync(path.join(tmpdir(), "querystale-"));
const store = new Store(dir);
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A pooled connection that has INBOX selected sees mail delivered since only
// after its next NOOP, and its HIGHESTMODSEQ stays put until then. A refresh
// after IDLE reported the arrival must still list the new message.
it("lists mail that arrived while the pooled connection kept its old view", async () => {
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  store
    .prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'INBOX', 1)`)
    .run(account.id);
  const mailboxIdx = (store.prep(`SELECT id FROM mailbox WHERE name = 'INBOX'`).get() as { id: number }).id;

  const server = [1, 2];
  let view = [...server];
  const client = {
    mailbox: { path: "INBOX", uidValidity: 1n, highestModseq: 5n },
    getMailboxLock: async () => ({ release: () => {} }),
    noop: async () => {
      view = [...server];
    },
    search: async () => view,
  } as unknown as ImapFlow;
  const ctx = { account, client, store };
  const args = {
    accountId: String(account.id),
    filter: { inMailbox: encodeMailboxId({ accountIdx: account.id, mailboxIdx }) },
    sort: [{ property: "receivedAt", isAscending: false }],
  };

  expect((await emailQuery(args as never, ctx)).ids).toHaveLength(2);
  server.push(3);
  store.bumpState(account.id, "email"); // IDLE: EXISTS grew
  expect((await emailQuery(args as never, ctx)).ids).toHaveLength(3);
});
