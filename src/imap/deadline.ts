// A command the mail server leaves unanswered. imapflow's own inactivity limit
// is five minutes, during which the connection and every request waiting for
// it are stuck.

import { JmapError } from "../jmap/errors.js";
import { log } from "../util/log.js";

/** How long a SEARCH may take. Read per call so that tests can shorten it. */
/**
 * How long a full-text search may take over all its folders. Below the 30 s
 * after which the webmail stops waiting, so that it gets an answer.
 */
export const textSearchMs = (): number => Number(process.env.IMAP_TEXT_SEARCH_TIMEOUT_MS ?? 25_000);

export const searchTimeoutMs = (): number => Number(process.env.IMAP_SEARCH_TIMEOUT_MS ?? 60_000);

/**
 * Run `work` on `client` and close the connection, which fails `work`, when it
 * takes longer than `ms` or once `signal` aborts. A command cannot be taken
 * back on a connection that stays open.
 */
export async function withDeadline<T>(
  client: { close?: () => void },
  ms: number,
  what: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let stopped: (reason: Error) => void = () => {};
  const stop = new Promise<never>((_, reject) => (stopped = reject));
  const end = (reason: string) => {
    log.warn({ what, reason }, "imap command given up; closing its connection");
    client.close?.();
    stopped(new JmapError("serverUnavailable", `${what}: ${reason}`));
  };
  const timer = setTimeout(() => end("no answer from the mail server in time"), ms);
  const onAbort = () => end("the client closed the request");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const running = work();
    // Closing the connection fails it as well, after nobody waits for it.
    running.catch(() => {});
    return await Promise.race([running, stop]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    stop.catch(() => {});
  }
}
