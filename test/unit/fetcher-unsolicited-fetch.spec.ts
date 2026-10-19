// Gmail pushes `* n FETCH (UID x FLAGS (...))` when another session changes
// flags, and imapflow returns it with the results of whatever FETCH is running.
// Taken as the answer, it had no BODYSTRUCTURE: Email/get failed with
// "Cannot read properties of null (reading 'type')", and the hasAttachment
// filter cached the string "null" that broke every later Email/get.

import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";
import { Store } from "../../src/state/store.js";

const BODYSTRUCTURE = '("text" "plain" ("charset" "UTF-8") NIL NIL "7bit" 5 1 NIL NIL NIL NIL)';

function startServer(seen: { metaFetches: number }): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    sock.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = "", ...rest] = line.split(" ");
        const c = cmd.toUpperCase();
        if (c === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else if (c === "SELECT" || c === "EXAMINE")
          sock.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] x\r\n* OK [UIDNEXT 8] x\r\n${tag} OK [READ-WRITE] x\r\n`);
        else if (c === "UID" && rest[0]?.toUpperCase() === "FETCH" && line.includes("BODYSTRUCTURE")) {
          seen.metaFetches++;
          sock.write(
            `* 1 FETCH (UID 7 FLAGS () RFC822.SIZE 100 INTERNALDATE "05-Oct-2026 19:03:15 +0200"` +
              ` ENVELOPE (NIL "Hello" NIL NIL NIL NIL NIL NIL NIL "<m@example.org>") BODYSTRUCTURE ${BODYSTRUCTURE}` +
              ` BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)] {2}\r\n\r\n)\r\n` +
              `* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n${tag} OK\r\n`,
          );
        } else if (c === "UID" && rest[0]?.toUpperCase() === "FETCH") {
          sock.write(`* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n${tag} OK\r\n`);
        } else if (c === "LOGOUT") {
          sock.write(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

let server: net.Server | null = null;
let dir: string | null = null;
afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: (server!.address() as net.AddressInfo).port,
    secure: false,
    auth: { user: "u", pass: "p" },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout();
  }
}

describe("FLAGS-only FETCH pushed during a FETCH", () => {
  it("does not replace the real answer", async () => {
    server = await startServer({ metaFetches: 0 });
    const email = await withClient(async (client) =>
      (await fetchEmailsBatch(client, { id: 1 } as never, { id: 2, uidvalidity: 1 } as never, [7])).get(7),
    );
    expect(email?.subject).toBe("Hello");
  });

  it("refetches a cache row whose structure was stored as the string null", async () => {
    const seen = { metaFetches: 0 };
    server = await startServer(seen);
    dir = mkdtempSync(path.join(tmpdir(), "nullstruct-"));
    const store = new Store(dir);
    try {
      const account = store.upsertAccount({ slug: "a", kind: "gmail", host: "h", username: "u", vault: Buffer.from("v") });
      const mailboxId = Number(
        store.prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'INBOX', 1)`).run(account.id).lastInsertRowid,
      );
      store.upsertEmailCacheRows([
        {
          accountId: account.id,
          mailboxId,
          uidvalidity: 1,
          uid: 7,
          threadId: "t",
          internaldate: 0,
          size: 100,
          envelope: JSON.stringify({ subject: "Hello" }),
          bodystructure: "null",
          headersRaw: Buffer.from("\r\n"),
          headersFull: false,
          preview: null,
        },
      ]);
      const email = await withClient(async (client) =>
        (await fetchEmailsBatch(client, account, { id: mailboxId, uidvalidity: 1 } as never, [7], {}, store)).get(7),
      );
      expect(seen.metaFetches).toBe(1);
      expect(email?.subject).toBe("Hello");
    } finally {
      store.db.close();
    }
  });
});
