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
import { withDeadline } from "./deadline.js";
import { compileFilter, type Filter, type FilterCondition } from "./search.js";
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
export const resetTextSearch = (): void => known.clear();

export interface TextSearch {
  filter: Filter;
  /** When the search has to be done by. */
  until: number;
  /** Names the folder, its UIDVALIDITY included. */
  folderKey: string;
  signal?: AbortSignal;
  /** Drops candidates known not to match, before their text is searched. */
  narrow?: (uids: number[]) => number[];
}

/** Ascending UIDs matching `s.filter` in the open folder, or null when it can't be split. */
export async function searchText(client: ImapFlow, s: TextSearch): Promise<number[] | null> {
  const parts = splitTextFilter(s.filter);
  if (!parts || parts.text.length === 0) return null;
  const open = typeof client.mailbox === "object" && client.mailbox ? client.mailbox : null;
  const t0 = Date.now();
  const search = async (query: Record<string, unknown>, what: string): Promise<number[]> => {
    if (Date.now() >= s.until) {
      throw new JmapError("serverUnavailable", "the mail server takes too long to search the text of all messages");
    }
    return searchedUids(
      client,
      await withDeadline(client, s.until - Date.now(), `${what} in ${open?.path ?? ""}`, () => client.search(query, { uid: true }), s.signal),
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
  let done = 0;
  try {
    for (let step = FIRST_STEP; done < todo.length; ) {
      const uids = todo.slice(done, done + step);
      const started = Date.now();
      for (const set of uidSets(uids)) {
        for (const uid of await search({ uid: set, ...text }, `text SEARCH of ${uids.length} messages`)) k.matched.add(uid);
      }
      for (const uid of uids) k.searched.add(uid);
      done += uids.length;
      if (Date.now() - started < STEP_TARGET_MS) step = Math.min(step * 2, MAX_STEP);
    }
  } finally {
    const ms = Date.now() - t0;
    if (ms >= 1_000) {
      log.info(
        { mailbox: open?.path, messages: open?.exists, criteria: inFolder.length, candidates: candidates.length, known: before, searched: done, left: todo.length - done, ms },
        "slow text search in folder",
      );
    }
  }
  if (Object.keys(text).length === 0) return candidates;
  return candidates.filter((uid) => k.matched.has(uid)).sort((a, b) => a - b);
}
