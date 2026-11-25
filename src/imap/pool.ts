import type { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { AppConfig } from "../util/config.js";
import { resolveProvider } from "../auth/providers.js";
import { openAccountCredentials } from "../auth/credentials.js";
import { isTemporaryLoginRefusal, MailServerBusy, PoolWaitTimeout } from "./busy.js";
import { withDeadline } from "./deadline.js";
import { isCredentialRefusal, openImap } from "./client.js";
import { nextStoredAttemptAt, type Store, type AccountRow } from "../state/store.js";
import { log } from "../util/log.js";

interface PoolEntry {
  client: ImapFlow;
  lastUsed: number;
  // True while a caller holds this connection. imapflow serialises commands
  // per socket, so handing one connection to two concurrent callers would
  // queue them behind each other — exactly what the pool exists to avoid.
  busy: boolean;
  // Logged in with credentials that are no longer the account's: closed as
  // soon as its borrower gives it back.
  retired?: boolean;
  /**
   * The account's email state when this session last synced its mailbox view.
   * Dovecot shows a session mail added through another connection only once
   * it syncs, so a connection lent after the state moved gets a NOOP first.
   *
   * The state moves on a write through the proxy and on what IDLE reports for
   * INBOX. Mail the server files into another folder leaves it where it is:
   * a connection with that folder selected syncs at the idle NOOP only.
   */
  emailState: number;
}

// Skip the sanity-NOOP if the connection was used within this window.
// Every JMAP method funnels through acquire, so a per-call NOOP adds one IMAP
// round-trip to every request - visible as multi-second latency on slow links.
// Most servers don't drop idle TCP for tens of seconds, so we only NOOP after
// a meaningful idle gap.
const NOOP_FRESHNESS_MS = 30_000;

// A free connection is logged out once nobody has borrowed it for this long.
// imapflow keeps a quiet socket in IDLE and servers never time those out, so
// without a reaper every account that touched the proxy once keeps its whole
// pool open for the day — on a shared server that is what fills the global
// login-process limit. The first request after a pause pays one
// TCP+TLS+LOGIN, the same price as after a dropped socket.
const IDLE_MAX_MS = 5 * 60_000;
const REAP_INTERVAL_MS = 60_000;

// After the server turned a login away for now (a connection limit, most
// often), no further dial for the account until this long has passed; doubled
// with every such answer in a row.
const DIAL_PAUSE_MIN_MS = 5_000;
const DIAL_PAUSE_MAX_MS = 60_000;

// Two connection roles per account:
//   - "interactive": JMAP method calls (the latency-sensitive path).
//   - "bulk": blob downloads and thread-index scans — operations that can
//     hold the socket for seconds. Splitting them keeps a 20 MB attachment
//     download or a first-time account scan from freezing every other
//     request for the account.
export type PoolRole = "interactive" | "bulk";

// How many sockets each role may open per account. A browser issues several
// JMAP requests at once (folder list, message list, open message); with a
// single interactive socket they all queued behind one another inside
// imapflow. Kept small so one user cannot exhaust a server's per-account
// connection limit — IMAP servers commonly cap that in the 4-10 range, and
// the push IDLE worker holds one more outside this pool.
const MAX_PER_ROLE: Record<PoolRole, number> = {
  interactive: 3,
  bulk: 2,
};

// How long a request waits for a connection. Without a limit, requests behind
// connections that are stuck pile up until the account's request limit refuses
// every further one.
const poolWaitMs = (): number => Number(process.env.IMAP_POOL_WAIT_MS ?? 20_000);

// A NOOP on a connection that still works is answered at once.
const NOOP_TIMEOUT_MS = 10_000;

/** A borrowed connection. `release` must be called exactly once. */
export interface Lease {
  client: ImapFlow;
  release: () => void;
}

export class ImapPool {
  private entries = new Map<string, PoolEntry[]>();
  // Callers parked waiting for a connection to come free, per pool key.
  private waiters = new Map<string, Array<(released: boolean) => void>>();
  // Connections being opened, per pool key.
  private opening = new Map<string, number>();
  // Accounts whose stored credentials opened a connection in this process,
  // and the chain of dials for those that have not (see takeFree).
  private verified = new Set<number>();
  private dialLocks = new Map<number, Promise<void>>();
  // Accounts whose last dial the server turned away for now.
  private dialPauses = new Map<number, { until: number; ms: number }>();
  private reaper: NodeJS.Timeout;

  constructor(
    private cfg: AppConfig,
    private store: Store,
  ) {
    this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    // A pool with nothing in it must not keep the process alive.
    this.reaper.unref();
  }

  /**
   * Borrow a connection for the duration of `fn`. The connection returns to
   * the pool whether `fn` resolves or throws.
   */
  async withConnection<T>(
    account: AccountRow,
    role: PoolRole,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(account, role);
    try {
      return await fn(lease.client);
    } finally {
      lease.release();
    }
  }

  /**
   * Borrow a connection with an explicit release. Prefer `withConnection`;
   * this exists for callers whose use outlives a single async scope, such as
   * the blob download route streaming a response body.
   */
  async acquire(account: AccountRow, role: PoolRole = "interactive"): Promise<Lease> {
    const key = `${account.id}:${role}`;
    const requestedAt = Date.now();
    for (;;) {
      let taken: { entry: PoolEntry } | { parked: Promise<boolean> };
      try {
        taken = await this.takeFree(account, key, role, requestedAt);
      } catch (e) {
        if (!(e instanceof MailServerBusy) || !this.hasConnections(key)) throw e;
        // The role has connections, only no further one: share those.
        continue;
      }
      if ("entry" in taken) return this.leaseFor(key, taken.entry);
      // At the cap with everything busy: park until someone releases, then
      // re-run the whole selection (the freed entry may have died meanwhile).
      if (!(await taken.parked)) throw new PoolWaitTimeout();
    }
  }

  /**
   * Claim a usable idle connection, or open one if the role is under its cap.
   * When every slot is taken the caller is parked, in the same step as the
   * check so that no release slips in between. `requestedAt` is when the
   * request asked for the connection (see nextStoredAttemptAt).
   */
  private async takeFree(
    account: AccountRow,
    key: string,
    role: PoolRole,
    requestedAt: number,
  ): Promise<{ entry: PoolEntry } | { parked: Promise<boolean> }> {
    const list = [...(this.entries.get(key) ?? [])];
    for (const entry of list) {
      if (entry.busy) continue;
      if (!entry.client.usable) {
        this.drop(key, entry);
        continue;
      }
      entry.busy = true;
      const idleMs = Date.now() - entry.lastUsed;
      entry.lastUsed = Date.now();
      const emailState = this.store.getState(account.id, "email");
      if (idleMs < NOOP_FRESHNESS_MS && entry.emailState === emailState) return { entry };
      try {
        await withDeadline(entry.client, NOOP_TIMEOUT_MS, "NOOP", () => entry.client.noop());
        entry.emailState = emailState;
        return { entry };
      } catch {
        // Dead despite looking usable; drop it and keep looking.
        entry.busy = false;
        this.drop(key, entry);
      }
    }

    // Connections still being opened count against the cap too.
    const opening = this.opening.get(key) ?? 0;
    if ((this.entries.get(key)?.length ?? 0) + opening >= MAX_PER_ROLE[role]) {
      return { parked: this.waitForRelease(key, requestedAt) };
    }
    if (this.dialsPaused(account.id)) {
      if (this.hasConnections(key)) return { parked: this.waitForRelease(key, requestedAt) };
      // Nobody is left to release a connection: the others parked here learn it too.
      this.wake(key);
      throw new MailServerBusy();
    }
    this.opening.set(key, opening + 1);
    let unlock: (() => void) | null = null;
    let opened = false;
    try {
      // Until the stored credentials have worked in this process, and again
      // after the server refused them, the account's dials go one at a time:
      // each one sees the refusals of the one before, so requests that arrive
      // together cannot send more logins than the refused mark allows.
      if (!this.verified.has(account.id)) unlock = await this.lockDials(account.id);
      // The dial this one waited for may have been turned away.
      if (this.dialsPaused(account.id)) throw new MailServerBusy();

      // Dial with the credentials the row holds now, not the ones the request
      // started with, and not at all once the mail server refused them: the
      // next successful login clears that mark.
      const current = this.store.getAccountById(account.id);
      if (!current || current.cred_refused) throw new Error("stored credentials refused by the mail server");
      // After a refusal the next try waits its turn, except once for a request
      // made after it (see nextStoredAttemptAt).
      if (Date.now() < nextStoredAttemptAt(current, requestedAt)) {
        throw new Error("stored credentials refused by the mail server; trying again later");
      }
      const provider = resolveProvider(this.cfg, current.kind);
      const creds: Credentials = await openAccountCredentials(this.cfg.vaultKey, current);
      let client: ImapFlow;
      try {
        client = await openImap({ provider, creds });
      } catch (e) {
        if (isCredentialRefusal(e)) {
          this.verified.delete(account.id);
          this.store.noteCredentialRefusal(current.id, current.cred_gen);
        }
        if (isTemporaryLoginRefusal(e)) {
          this.pauseDials(account, e);
          throw new MailServerBusy();
        }
        throw e;
      }
      this.dialPauses.delete(account.id);
      if (current.cred_refusals > 0) this.store.noteCredentialSuccess(current.id);
      this.verified.add(account.id);
      const emailState = this.store.getState(account.id, "email");
      const entry: PoolEntry = { client, lastUsed: Date.now(), busy: true, emailState };
      this.attach(account, key, entry);
      opened = true;
      return { entry };
    } finally {
      unlock?.();
      const left = (this.opening.get(key) ?? 1) - 1;
      if (left > 0) this.opening.set(key, left);
      else this.opening.delete(key);
      // A slot reserved for a dial that failed is free again.
      if (!opened) this.wake(key);
    }
  }

  /** True when the role has connections, open or being opened, that will be given back. */
  private hasConnections(key: string): boolean {
    return (this.entries.get(key)?.length ?? 0) + (this.opening.get(key) ?? 0) > 0;
  }

  private dialsPaused(accountId: number): boolean {
    return Date.now() < (this.dialPauses.get(accountId)?.until ?? 0);
  }

  private pauseDials(account: AccountRow, e: unknown): void {
    const before = this.dialPauses.get(account.id);
    // Dials that were under way together count as one answer.
    if (before && Date.now() < before.until) return;
    const ms = Math.min(before ? before.ms * 2 : DIAL_PAUSE_MIN_MS, DIAL_PAUSE_MAX_MS);
    this.dialPauses.set(account.id, { until: Date.now() + ms, ms });
    const err = e as { responseText?: string; serverResponseCode?: string };
    log.warn(
      { account: account.slug, pauseMs: ms, responseText: err.responseText, serverResponseCode: err.serverResponseCode },
      "imap login turned away for now; pausing new connections",
    );
  }

  /** Wait for the account's previous dial to finish; returns the release for this one. */
  private async lockDials(accountId: number): Promise<() => void> {
    const previous = this.dialLocks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.dialLocks.set(accountId, tail);
    await previous;
    return () => {
      release();
      if (this.dialLocks.get(accountId) === tail) this.dialLocks.delete(accountId);
    };
  }

  private leaseFor(key: string, entry: PoolEntry): Lease {
    let released = false;
    return {
      client: entry.client,
      release: () => {
        if (released) return;
        released = true;
        entry.busy = false;
        entry.lastUsed = Date.now();
        // A caller that killed the socket (or found it dead) must not leave a
        // corpse in the pool for the next borrower to trip over.
        if (!entry.client.usable) this.drop(key, entry);
        else if (entry.retired) {
          this.drop(key, entry);
          entry.client.logout().catch(() => {});
        }
        this.wake(key);
      },
    };
  }

  /** True once a connection may be free, false when the request has waited long enough. */
  private waitForRelease(key: string, requestedAt: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const waiter = (released: boolean) => {
        clearTimeout(timer);
        resolve(released);
      };
      const timer = setTimeout(() => {
        const queue = this.waiters.get(key);
        const i = queue?.indexOf(waiter) ?? -1;
        if (i < 0) return;
        queue!.splice(i, 1);
        if (queue!.length === 0) this.waiters.delete(key);
        log.warn({ key }, "imap pool: no connection came free in time");
        waiter(false);
      }, Math.max(0, requestedAt + poolWaitMs() - Date.now()));
      const queue = this.waiters.get(key) ?? [];
      queue.push(waiter);
      this.waiters.set(key, queue);
    });
  }

  private wake(key: string): void {
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    if (queue.length === 0) this.waiters.delete(key);
    next(true);
  }

  // Hand a live, already-authenticated connection to the pool. The auth paths
  // open a probe connection to validate credentials; adopting it saves the
  // immediately-following JMAP request from paying a second TCP+TLS+LOGIN
  // handshake. If the interactive role is already at its cap the probe is
  // logged out.
  adopt(account: AccountRow, client: ImapFlow): void {
    const key = `${account.id}:interactive`;
    // A dial in flight will land in the pool too.
    const opening = this.opening.get(key) ?? 0;
    if ((this.entries.get(key)?.length ?? 0) + opening >= MAX_PER_ROLE.interactive) {
      client.logout().catch(() => {});
      return;
    }
    this.attach(account, key, { client, lastUsed: Date.now(), busy: false, emailState: this.store.getState(account.id, "email") });
    this.wake(key);
  }

  /**
   * Close every connection of the account: idle ones now, borrowed ones when
   * they are given back. Called when the account's credentials change, so no
   * connection logged in with the old ones keeps serving requests.
   */
  retire(accountId: number): void {
    // The new credentials have not opened a connection yet.
    this.verified.delete(accountId);
    for (const role of Object.keys(MAX_PER_ROLE) as PoolRole[]) {
      const key = `${accountId}:${role}`;
      for (const entry of [...(this.entries.get(key) ?? [])]) {
        if (entry.busy) {
          entry.retired = true;
          continue;
        }
        this.drop(key, entry);
        entry.client.logout().catch(() => {});
      }
      this.wake(key);
    }
  }

  /** Log out every free connection that nobody has borrowed for IDLE_MAX_MS. */
  reapIdle(): void {
    const cutoff = Date.now() - IDLE_MAX_MS;
    for (const [key, list] of this.entries) {
      for (const entry of [...list]) {
        if (entry.busy || entry.lastUsed > cutoff) continue;
        // Out of the pool before the LOGOUT round-trip, so no caller can
        // borrow a socket that is on its way out.
        this.drop(key, entry);
        entry.client.logout().catch(() => {});
      }
    }
  }

  private attach(account: AccountRow, key: string, entry: PoolEntry): void {
    entry.client.on("close", () => {
      // Only a socket the pool still counted on is worth a warning; one the
      // reaper or a borrower already dropped is closing on purpose.
      if (this.drop(key, entry)) log.warn({ account: account.slug, key }, "imap connection closed");
      // A slot just opened up, so let a parked caller dial a replacement.
      this.wake(key);
    });
    entry.client.on("error", (err: Error) => {
      log.warn({ account: account.slug, key, err: err.message }, "imap connection error");
      this.drop(key, entry);
      this.wake(key);
    });
    const list = this.entries.get(key) ?? [];
    list.push(entry);
    this.entries.set(key, list);
  }

  /** Forget a connection. Returns false when the pool no longer held it. */
  private drop(key: string, entry: PoolEntry): boolean {
    const list = this.entries.get(key);
    if (!list) return false;
    const i = list.indexOf(entry);
    if (i < 0) return false;
    list.splice(i, 1);
    if (list.length === 0) this.entries.delete(key);
    return true;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    for (const list of this.entries.values()) {
      for (const e of list) {
        try {
          await e.client.logout();
        } catch {
          // best effort
        }
      }
    }
    this.entries.clear();
    // Nobody is coming back for these; unblock anyone still parked.
    for (const queue of this.waiters.values()) for (const resolve of queue) resolve(true);
    this.waiters.clear();
  }
}
