import { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { ProviderConfig } from "../util/config.js";
import { log } from "../util/log.js";

export interface ImapConnOpts {
  provider: ProviderConfig;
  creds: Credentials;
}

export async function openImap(opts: ImapConnOpts): Promise<ImapFlow> {
  const { provider, creds } = opts;
  let auth: { user: string; pass?: string; accessToken?: string };
  if (creds.mech === "XOAUTH2" && creds.accessToken) {
    auth = { user: creds.username, accessToken: creds.accessToken };
  } else if (creds.password) {
    auth = { user: creds.username, pass: creds.password };
  } else {
    throw new Error("openImap: no credentials supplied");
  }
  const client = new ImapFlow({
    host: provider.imap.host,
    port: provider.imap.port,
    secure: provider.imap.secure ?? true,
    auth,
    logger: imapflowLogger,
  });
  // imapflow reports a socket timeout or reset as an 'error' event, and an
  // EventEmitter with no listener throws it from a timer: an uncaught
  // exception with no frame of ours in it (#25). The pool and the IDLE worker
  // add listeners that act on the error; this one only keeps every client,
  // the short-lived auth probes included, from having none.
  client.on("error", (err: unknown) => {
    log.debug({ host: provider.imap.host, ...imapErrorDetails(err) }, "imap connection error");
  });
  await client.connect();
  log.debug({ host: provider.imap.host, mech: creds.mech }, "imap connected");
  return client;
}

// imapflow reports a failed MOVE or COPY only by returning false and logging
// the error. Keep its warnings so the server's NO text reaches our log; the
// rest of its logging stays off, as before.
const imapflowLogger = {
  debug: () => {},
  info: () => {},
  error: () => {},
  warn: (obj: { msg?: string; err?: unknown; cid?: string }) =>
    log.warn({ cid: obj?.cid, ...(obj?.err ? imapErrorDetails(obj.err) : {}) }, obj?.msg ?? "imap command failed"),
};

export async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  fn: (lock: { release: () => void }) => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn({ release: () => lock.release() });
  } finally {
    lock.release();
  }
}

// A pooled connection that already has the mailbox selected hears about
// messages appended on another connection only with its next command's
// untagged EXISTS - and the pool skips its NOOP for recently used
// connections. A UID FETCH for a message just stored elsewhere (a draft
// imported and submitted in one request, or read back right after saving)
// can therefore come back empty. Ask once more after a NOOP before treating
// the message as gone.
export async function fetchAfterNoop<T>(
  client: ImapFlow,
  where: { mailbox: string; uid: number },
  fetch: () => Promise<T | null>,
): Promise<T | null> {
  const first = await fetch();
  if (first != null) return first;
  await client.noop();
  const second = await fetch();
  if (second != null) log.info(where, "imap: message only visible after NOOP");
  return second;
}

// The server's side of a failed IMAP command. imapflow puts the tagged NO/BAD
// text on the error object; without it the log only says "Command failed".
export function imapErrorDetails(e: unknown): Record<string, unknown> {
  const err = e as {
    message?: string;
    responseText?: string;
    responseStatus?: string;
    serverResponseCode?: string;
    code?: string;
  };
  return {
    err: err?.message ?? String(e),
    responseStatus: err?.responseStatus,
    responseText: err?.responseText,
    serverResponseCode: err?.serverResponseCode,
    code: err?.code,
  };
}
