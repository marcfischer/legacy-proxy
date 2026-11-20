import type { ImapFlow } from "imapflow";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { fetchAfterNoop } from "../../src/imap/client.js";
import { readBlob } from "../../src/jmap/blobs.js";
import { encodeBlobId, encodeEmailId } from "../../src/mapping/ids.js";
import type { AccountRow, Store } from "../../src/state/store.js";

// A connection that had the mailbox selected before another one appended
// uid 7: the message only shows up once a NOOP has delivered the EXISTS.
function staleClient() {
  const calls: string[] = [];
  let synced = false;
  const client = {
    async getMailboxLock() {
      calls.push("lock");
      return { release() {} };
    },
    async noop() {
      calls.push("noop");
      synced = true;
    },
    async download() {
      calls.push("download");
      if (!synced) return {};
      return { meta: { contentType: "application/pkcs7-signature" }, content: Readable.from([Buffer.from("sig")]) };
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

describe("fetchAfterNoop", () => {
  it("returns the first result without a NOOP", async () => {
    const { client, calls } = staleClient();
    expect(await fetchAfterNoop(client, { mailbox: "Drafts", uid: 7 }, async () => "x")).toBe("x");
    expect(calls).toEqual([]);
  });

  it("retries once after a NOOP and gives up after that", async () => {
    const { client, calls } = staleClient();
    let n = 0;
    const res = await fetchAfterNoop(client, { mailbox: "Drafts", uid: 7 }, async () => {
      n++;
      return null;
    });
    expect(res).toBeNull();
    expect(n).toBe(2);
    expect(calls).toEqual(["noop"]);
  });

  it("lets readBlob find a part of a message appended on another connection", async () => {
    const { client, calls } = staleClient();
    const store = {
      getCachedBlob: () => null,
      prep: () => ({ get: () => ({ id: 3, name: "Drafts" }) }),
    } as unknown as Store;
    const account = { id: 1 } as AccountRow;
    const emailId = encodeEmailId({ accountIdx: 1, mailboxIdx: 3, uidvalidity: 1, uid: 7 });

    const blob = await readBlob(encodeBlobId(emailId, "2"), { account, store, client });

    expect(blob?.body.toString()).toBe("sig");
    expect(blob?.ctype).toBe("application/pkcs7-signature");
    expect(calls).toEqual(["lock", "download", "noop", "download"]);
  });
});
