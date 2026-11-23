// A mail server that has no connection left for the user (Dovecot's
// mail_max_userip_connections: NO [LIMIT] to the login). The password is
// right, so the client must not be signed out; a request shares the
// connections that are there, and an account-wide query never leaves out the
// folders it could not reach.
// Runs against an IMAP server on 127.0.0.1 only.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import { ImapPool } from "../../src/imap/pool.js";
import { MailServerBusy } from "../../src/imap/busy.js";
import { Store, type AccountRow } from "../../src/state/store.js";
import { sealCredentials, sealPlace } from "../../src/auth/credentials.js";
import { emailQuery, resetFolderSearchCache } from "../../src/jmap/methods/email.js";
import { listMailboxes, resetMailboxListCache } from "../../src/jmap/methods/mailbox.js";
import type { AppConfig } from "../../src/util/config.js";

process.env.LOG_LEVEL = "silent";

const LIMIT = "NO [LIMIT] Maximum number of connections from user+IP exceeded (mail_max_userip_connections=35)";

/** Lets in `free` connections at a time and answers further logins with LIMIT. */
async function limitedServer(free: number) {
  const state = { free, open: 0, logins: 0, port: 0, close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    let counted = false;
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => {
      sockets.delete(sock);
      if (counted) state.open--;
    });
    sock.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] hi\r\n");
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("latin1");
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const [tag, cmd] = buf.slice(0, nl).split(" ");
        buf = buf.slice(nl + 2);
        if (/^(AUTHENTICATE|LOGIN)$/i.test(cmd ?? "")) {
          state.logins++;
          if (state.open < state.free) {
            counted = true;
            state.open++;
            sock.write(`${tag} OK\r\n`);
          } else sock.write(`${tag} ${LIMIT}\r\n`);
        } else if (/^CAPABILITY$/i.test(cmd ?? "")) sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK\r\n`);
        else if (/^LOGOUT$/i.test(cmd ?? "")) sock.end(`* BYE\r\n${tag} OK\r\n`);
        else if (tag) sock.write(`${tag} OK\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return state;
}

let dir: string;
let store: Store;
let account: AccountRow;
const vaultKey = crypto.randomBytes(32);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-limit-"));
  store = new Store(dir);
  resetFolderSearchCache();
  resetMailboxListCache();
  account = store.upsertAccount({
    slug: "generic:u",
    kind: "generic",
    host: "127.0.0.1",
    username: "u",
    vault: await sealCredentials(vaultKey, sealPlace.account("generic:u"), { mech: "PLAIN", username: "u", password: "right" }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function poolOn(port: number): ImapPool {
  const generic = { imap: { host: "127.0.0.1", port, secure: false }, smtp: { host: "127.0.0.1", port: 1, secure: false }, auth: { mech: ["PLAIN"] } };
  return new ImapPool({ vaultKey, defaultProvider: "generic", providers: { generic } } as unknown as AppConfig, store);
}

describe("the pool", () => {
  it("serves requests that arrive together from the one connection the server grants", async () => {
    const server = await limitedServer(1);
    const pool = poolOn(server.port);
    const done: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        pool.withConnection(account, "interactive", async (c) => {
          await c.noop();
          done.push(n);
        }),
      ),
    );
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    // One login that worked, at most two more under way before the first LIMIT.
    expect(server.logins).toBeLessThanOrEqual(3);
    await pool.closeAll();
    await server.close();
  });

  it("tells every waiting request when there is no connection, and stops asking for a while", async () => {
    const server = await limitedServer(0);
    const pool = poolOn(server.port);
    const burst = () => Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8].map(() => pool.acquire(account, "interactive")));
    for (const r of await burst()) expect(r).toMatchObject({ status: "rejected", reason: expect.any(MailServerBusy) });
    expect(server.logins).toBe(1);
    await burst();
    expect(server.logins).toBe(1);
    // Not the password's fault.
    expect(store.getAccountById(account.id)).toMatchObject({ cred_refused: 0, cred_refusals: 0 });
    expect(new MailServerBusy().toMethodError().type).toBe("serverUnavailable");

    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 6_000);
    server.free = 1;
    (await pool.acquire(account, "interactive")).release();
    expect(server.logins).toBe(2);
    await pool.closeAll();
    await server.close();
  });

  it("waits longer after each answer in a row", async () => {
    const server = await limitedServer(0);
    const pool = poolOn(server.port);
    const start = Date.now();
    let at = 0;
    vi.spyOn(Date, "now").mockImplementation(() => start + at);
    const tryAt = async (ms: number) => {
      at = ms;
      await pool.acquire(account, "bulk").catch(() => {});
      return server.logins;
    };
    expect(await tryAt(0)).toBe(1);
    expect(await tryAt(4_900)).toBe(1);
    expect(await tryAt(5_100)).toBe(2);
    expect(await tryAt(14_900)).toBe(2);
    expect(await tryAt(15_200)).toBe(3);
    await pool.closeAll();
    await server.close();
  });
});

describe("an account-wide Email/query", () => {
  const FOLDERS = ["INBOX", "Archive", "Projects", "Receipts"];
  function client(failing: { folder: string; error: Error } | null = null) {
    let held: Promise<void> = Promise.resolve();
    let inside = 0;
    const c = {
      mailbox: false as unknown,
      overlapped: false,
      list: async () =>
        FOLDERS.map((p) => ({
          path: p, name: p, delimiter: "/", subscribed: true,
          status: { messages: 1, unseen: 0, uidNext: 2, uidValidity: 7n },
        })),
      getMailboxLock: async (p: string) => {
        const prev = held;
        let release!: () => void;
        held = new Promise<void>((r) => (release = r));
        await prev;
        if (failing?.folder === p) {
          release();
          throw failing.error;
        }
        if (inside++ > 0) c.overlapped = true;
        c.mailbox = { path: p, uidValidity: 7n };
        let done = false;
        return { release: () => { if (!done) { done = true; inside--; release(); } } };
      },
      noop: async () => {},
      search: async () => [1],
      fetch: async function* () { yield { uid: 1, internalDate: new Date(0) }; },
    };
    return c;
  }
  const query = (c: ReturnType<typeof client>, pool?: unknown) =>
    emailQuery(
      { accountId: String(account.id), filter: { hasKeyword: "$label:x" }, calculateTotal: true } as never,
      { account, client: c as unknown as ImapFlow, store, pool } as never,
    );

  it("walks the folders on its own connection when there is no bulk one", async () => {
    const c = client();
    await listMailboxes(c as unknown as ImapFlow, account, store);
    const pool = { withConnection: async () => { throw new MailServerBusy(); } };
    expect((await query(c, pool)).total).toBe(4);
    expect(c.overlapped).toBe(false);
  });

  it("fails when a folder could not be reached, instead of leaving it out", async () => {
    const c = client({ folder: "Projects", error: Object.assign(new Error("Connection not available"), { code: "NoConnection" }) });
    await expect(query(c)).rejects.toThrow("Connection not available");
  });

  it("still leaves out a folder the server refuses to open", async () => {
    const c = client({ folder: "Projects", error: Object.assign(new Error("Command failed"), { responseStatus: "NO" }) });
    expect((await query(c)).total).toBe(3);
  });
});
