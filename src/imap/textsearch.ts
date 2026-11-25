// Full-text search of one folder for servers that read every message for it.
//
// A single SEARCH over a large folder gives no answer until the last message
// is read, and all of that work is lost when the client stops waiting. So the
// criteria the server answers from its index go first, and the text of what is
// left is searched in small steps, newest messages first. A message's text
// never changes: what a step found is kept, and a search sent again goes on
// where the last one ended.

import type { ImapFlow } from "imapflow";
import { JmapError } from "../jmap/errors.js";
import { log } from "../util/log.js";
import { searchedUids } from "./busy.js";
import { textStepMs, withDeadline } from "./deadline.js";
import { compileFilter, searchTokens, type Filter, type FilterCondition } from "./search.js";
import { uidSets } from "./uids.js";

const FIRST_STEP = 50;
const MAX_STEP = 500;
/** A step answered faster than this is followed by one twice its size. */
const STEP_TARGET_MS = 1_000;

/** True when the filter needs the server to read message text. */
export function searchesText(filter: Filter): boolean {
  if ("conditions" in filter) return filter.conditions.some(searchesText);
  return filter.text !== undefined || filter.body !== undefined;
}

/**
 * The filter as `cheap` AND `text`, the latter holding every condition that
 * needs message text. Null for text below an OR or NOT next to other criteria.
 */
export function splitTextFilter(filter: Filter): { cheap: FilterCondition[]; text: Filter[] } | null {
  if ("conditions" in filter) {
    if (filter.operator !== "AND") return searchesText(filter) ? null : { cheap: [filter as FilterCondition], text: [] };
    const out: { cheap: FilterCondition[]; text: Filter[] } = { cheap: [], text: [] };
    for (const c of filter.conditions) {
      const part = splitTextFilter(c);
      if (!part) return null;
      out.cheap.push(...part.cheap);
      out.text.push(...part.text);
    }
    return out;
  }
  const { text, body, ...cheap } = filter;
  return {
    cheap: Object.keys(cheap).length > 0 ? [cheap] : [],
    text: [...(text !== undefined ? [{ text }] : []), ...(body !== undefined ? [{ body }] : [])],
  };
}

// Per folder and search text: which UIDs were searched, and which matched.
interface Known {
  matched: Set<number>;
  searched: Set<number>;
}
const known = new Map<string, Known>();
const KNOWN_MAX = 64;

function knownFor(key: string): Known {
  const k = known.get(key) ?? { matched: new Set(), searched: new Set() };
  // Re-inserted, so that the oldest entry is the one unused for longest.
  known.delete(key);
  known.set(key, k);
  if (known.size > KNOWN_MAX) known.delete(known.keys().next().value!);
  return k;
}

/** For tests. */
export const resetTextSearch = (): void => {
  known.clear();
  stalled.clear();
};

/** The server left a step unanswered. Its connection is closed; a new try reads the messages instead. */
export class TextSearchStalled extends JmapError {
  constructor(folder: string) {
    super("serverUnavailable", `the mail server does not search the text of ${folder}`);
  }
}

// Up to this many messages are read and searched here without asking the
// server: that takes a moment, and an unanswered search seconds and a connection.
const readMax = (): number => Number(process.env.IMAP_TEXT_READ_MAX ?? 200);
// After this many unanswered folders of an account the server is asked only
// where reading takes far longer than another try.
const STALLS_PER_ACCOUNT = 2;
const TOO_MANY_TO_READ = 5_000;

// Folders whose text the server did not search, and until when not to ask it.
const stalled = new Map<string, number>();
const STALLED_MS = 5 * 60_000;

function isStalled(folderKey: string, messages: number): boolean {
  const now = Date.now();
  for (const [key, until] of stalled) if (until <= now) stalled.delete(key);
  if (stalled.has(folderKey)) return true;
  const account = folderKey.slice(0, folderKey.indexOf("|") + 1);
  const others = account ? [...stalled.keys()].filter((key) => key.startsWith(account)).length : 0;
  return others >= STALLS_PER_ACCOUNT && messages <= TOO_MANY_TO_READ;
}

/** What a message offers a search, decoded. */
export interface MessageText {
  /** Subject and addresses. */
  header: string;
  body: string;
}

const fold = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ");

/** RFC 8621 §4.4.1 `text` and `body` over a message that was read. */
export function matchesText(filters: Filter[], m: MessageText): boolean {
  const body = fold(m.body);
  const all = `${fold(m.header)}\n${body}`;
  const has = (words: string, where: string) => searchTokens(words).every((t) => where.includes(fold(t)));
  return filters.every((f) => {
    const c = f as FilterCondition;
    return (c.text === undefined || has(c.text, all)) && (c.body === undefined || has(c.body, body));
  });
}

export interface TextSearch {
  filter: Filter;
  /** When the search has to be done by. */
  until: number;
  /** Names the folder, its UIDVALIDITY included. */
  folderKey: string;
  signal?: AbortSignal;
  /** Drops candidates known not to match, before their text is searched. */
  narrow?: (uids: number[]) => number[];
  /** Reads messages, to search those of a folder the server does not. */
  read?: (client: ImapFlow, uids: number[]) => Promise<Map<number, MessageText>>;
}

/** Ascending UIDs matching `s.filter` in the open folder, or null when it can't be split. */
export async function searchText(client: ImapFlow, s: TextSearch): Promise<number[] | null> {
  const parts = splitTextFilter(s.filter);
  if (!parts || parts.text.length === 0) return null;
  const open = typeof client.mailbox === "object" && client.mailbox ? client.mailbox : null;
  const t0 = Date.now();
  const tooLong = () => new JmapError("serverUnavailable", "the mail server takes too long to search the text of all messages");
  const search = async (query: Record<string, unknown>, what: string, limit = s.until - Date.now()): Promise<number[]> => {
    if (Date.now() >= s.until) throw tooLong();
    return searchedUids(
      client,
      await withDeadline(client, Math.max(1, limit), `${what} in ${open?.path ?? ""}`, () => client.search(query, { uid: true }), s.signal),
    );
  };

  const cheap = compileFilter({ operator: "AND", conditions: parts.cheap });
  const inFolder = await search(Object.keys(cheap).length > 0 ? cheap : { all: true }, "SEARCH");
  const candidates = s.narrow ? s.narrow(inFolder) : inFolder;
  const text = compileFilter({ operator: "AND", conditions: parts.text });
  const k = knownFor(`${s.folderKey}|${JSON.stringify(text)}`);
  // An empty text matches everything, and needs nothing read.
  const todo = Object.keys(text).length === 0 ? [] : candidates.filter((uid) => !k.searched.has(uid)).sort((a, b) => b - a);
  const before = candidates.length - todo.length;
  const reading = s.read !== undefined && (todo.length <= readMax() || isStalled(s.folderKey, todo.length));
  let done = 0;

  const askServer = async (uids: number[]): Promise<void> => {
    for (const set of uidSets(uids)) {
      const asked = Date.now();
      const limit = s.read ? Math.min(textStepMs(), s.until - asked) : s.until - asked;
      try {
        for (const uid of await search({ uid: set, ...text }, `text SEARCH of ${uids.length} messages`, limit)) k.matched.add(uid);
      } catch (e) {
        if (!s.read || s.signal?.aborted || Date.now() - asked < textStepMs()) throw e;
        stalled.set(s.folderKey, Date.now() + STALLED_MS);
        throw new TextSearchStalled(open?.path ?? "");
      }
    }
  };
  const readThem = async (uids: number[]): Promise<void> => {
    if (Date.now() >= s.until) throw tooLong();
    const what = `reading ${uids.length} messages in ${open?.path ?? ""}`;
    const texts = await withDeadline(client, s.until - Date.now(), what, () => s.read!(client, uids), s.signal);
    // None at all is a connection or server that failed, not a step without matches.
    if (texts.size === 0) throw new JmapError("serverUnavailable", "the messages to search could not be read");
    if (texts.size < uids.length) log.warn({ mailbox: open?.path, missing: uids.length - texts.size }, "text search: messages could not be read");
    for (const [uid, m] of texts) if (matchesText(parts.text, m)) k.matched.add(uid);
  };
  try {
    for (let step = FIRST_STEP; done < todo.length; ) {
      const uids = todo.slice(done, done + step);
      const started = Date.now();
      await (reading ? readThem(uids) : askServer(uids));
      for (const uid of uids) k.searched.add(uid);
      done += uids.length;
      if (Date.now() - started < STEP_TARGET_MS) step = Math.min(step * 2, MAX_STEP);
    }
  } finally {
    const ms = Date.now() - t0;
    if (ms >= 1_000) {
      log.info(
        { mailbox: open?.path, messages: open?.exists, criteria: inFolder.length, candidates: candidates.length, reading, known: before, searched: done, left: todo.length - done, ms },
        "slow text search in folder",
      );
    }
  }
  if (Object.keys(text).length === 0) return candidates;
  return candidates.filter((uid) => k.matched.has(uid)).sort((a, b) => a - b);
}
