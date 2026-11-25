// A mail server that cannot take another login right now, as opposed to one
// that refuses the credentials.

import { JmapError } from "../jmap/errors.js";

// Response codes (RFC 5530) a server gives to a login it cannot serve right
// now. imapflow flags every NO to LOGIN/AUTHENTICATE as an authentication
// failure; these mean "try again later", not "wrong credentials". Stalwart
// answers a store error during the login with CONTACTADMIN, Dovecot answers
// LIMIT when the user has too many connections from one address.
const TEMPORARY_LOGIN_CODES = new Set(["UNAVAILABLE", "SERVERBUG", "INUSE", "LIMIT", "CONTACTADMIN"]);

/** True when the server turned a login away for now, whatever the credentials. */
export function isTemporaryLoginRefusal(e: unknown): boolean {
  const err = e as { authenticationFailed?: unknown; serverResponseCode?: unknown } | null;
  if (!err || err.authenticationFailed !== true) return false;
  return typeof err.serverResponseCode === "string" && TEMPORARY_LOGIN_CODES.has(err.serverResponseCode.toUpperCase());
}

/** How long a client is asked to wait after a login the server turned away for now. */
export const BUSY_RETRY_AFTER_SEC = 10;

/**
 * No connection could be had because the server takes no further login right
 * now. As a method error it is RFC 8620's serverUnavailable: the client may
 * send the same call again later.
 */
export class MailServerBusy extends JmapError {
  constructor() {
    super("serverUnavailable", "the mail server accepts no further connections right now");
  }
}

/** Every connection of the role stayed in use for as long as a request waits for one. */
export class PoolWaitTimeout extends JmapError {
  constructor() {
    super("serverUnavailable", "all connections to the mail server are in use");
  }
}

/** True when a request got no connection, for either reason. */
export const gotNoConnection = (e: unknown): boolean => e instanceof MailServerBusy || e instanceof PoolWaitTimeout;

/**
 * The UIDs a UID SEARCH found. imapflow answers `false` when the command
 * failed, which must not pass for a folder without matches.
 */
export function searchedUids(client: { usable?: boolean }, result: unknown): number[] {
  if (Array.isArray(result)) return result as number[];
  // The server's NO text is in imapflow's own warning. On a connection that
  // still works it was the server refusing the command.
  throw Object.assign(
    new JmapError("serverFail", "the mail server could not search the mailbox"),
    client.usable === false ? {} : { responseStatus: "NO" },
  );
}

/**
 * True when the server answered a command on a working connection with NO or
 * BAD: the mailbox is the problem, not the connection.
 */
export function isCommandRefusal(e: unknown): boolean {
  const err = e as { responseStatus?: unknown; authenticationFailed?: unknown } | null;
  if (!err || err.authenticationFailed === true) return false;
  return err.responseStatus === "NO" || err.responseStatus === "BAD";
}
