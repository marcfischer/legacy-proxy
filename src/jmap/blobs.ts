// Read a blob's bytes for building a message: uploads from SQLite, mail parts
// from the blob cache or else an IMAP fetch - the lookup the download route
// does, buffered instead of streamed.

import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import { fetchAfterNoop, withMailbox } from "../imap/client.js";
import type { ImapPool } from "../imap/pool.js";
import { decodeBlobId, decodeEmailId } from "../mapping/ids.js";
import type { AccountRow, Store } from "../state/store.js";
import { log } from "../util/log.js";

// Blob cache bounds, shared with the download route. The total cap keeps the
// database file bounded; the TTL keeps a deleted message's parts from
// lingering past the week a composer might reasonably stay open.
export const BLOB_CACHE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const BLOB_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

export async function readBlob(
  blobId: string,
  ctx: { account: AccountRow; store: Store; client: ImapFlow; pool?: ImapPool },
): Promise<{ body: Buffer; ctype: string } | null> {
  if (blobId.startsWith("U")) return ctx.store.getUpload(blobId, ctx.account.id);
  const cached = ctx.store.getCachedBlob(blobId, ctx.account.id);
  if (cached) return { body: cached.body, ctype: cached.ctype ?? "application/octet-stream" };

  let part: { emailId: string; partId: string | null };
  let email: { mailboxIdx: number; uid: number };
  try {
    part = decodeBlobId(blobId);
    email = decodeEmailId(part.emailId);
  } catch {
    return null;
  }
  const mbox = ctx.store
    .prep(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(email.mailboxIdx, ctx.account.id) as { id: number; name: string } | undefined;
  if (!mbox) return null;

  const fetch = (client: ImapFlow) =>
    withMailbox(client, mbox.name, async () => {
      // imapflow answers `{}` rather than null for an expunged message or part.
      const dl = await fetchAfterNoop(client, { mailbox: mbox.name, uid: email.uid }, async () => {
        const d = await client.download(`${email.uid}`, part.partId ?? undefined, { uid: true });
        return d?.content ? d : null;
      });
      if (!dl?.content) return null;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of dl.content) chunks.push(chunk as Buffer);
      } catch (e) {
        // A FETCH that broke off mid-literal leaves the connection
        // unparseable, so drop it rather than pool it.
        client.close();
        throw e;
      }
      return {
        body: Buffer.concat(chunks),
        ctype: part.partId ? dl.meta?.contentType ?? "application/octet-stream" : "message/rfc822",
      };
    });
  // Like the download route, fetch on the bulk connection so a large
  // forwarded attachment doesn't hold up the account's interactive calls.
  const blob = await (ctx.pool ? ctx.pool.withConnection(ctx.account, "bulk", fetch) : fetch(ctx.client));
  if (blob) keepBlob(blobId, blob, ctx);
  return blob;
}

// A part blobId names a message, and IMAP has no way to change a message: a
// draft saved again is a new message, and the version it replaces is deleted.
// The webmail keeps the blobIds it read from the draft it opened, so the save
// after that references parts of a message that no longer exists. Keeping
// every part we fetched under its blobId answers those saves (and downloads)
// from the cache instead of failing them with blobNotFound. Unlike the
// download route there is no per-part cap: the bytes are in memory already.
function keepBlob(blobId: string, blob: { body: Buffer; ctype: string }, ctx: { account: AccountRow; store: Store }): void {
  try {
    ctx.store.putCachedBlob({ id: blobId, accountId: ctx.account.id, ctype: blob.ctype, body: blob.body, ttlMs: BLOB_CACHE_TTL_MS });
    ctx.store.pruneBlobCache(BLOB_CACHE_MAX_TOTAL_BYTES);
  } catch (e) {
    // Best-effort, like the download route's cache write.
    log.warn({ err: (e as Error).message }, "blob cache write failed");
  }
}
