// Compile a JMAP Email/query FilterCondition (or FilterOperator tree) to an
// imapflow SearchObject. Unsupported subtrees throw `unsupportedFilter`.

import { keywordToFlag } from "../mapping/flags.js";

export type Filter =
  | FilterOperator
  | FilterCondition;

export interface FilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: Filter[];
}

export interface FilterCondition {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  before?: string;
  after?: string;
  minSize?: number;
  maxSize?: number;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: [string] | [string, string];
}

export class UnsupportedFilter extends Error {}

export interface ImapSearch {
  // imapflow SearchObject is a recursive plain object; we type it loosely.
  [k: string]: unknown;
}

export interface CompileOpts {
  // When the backend is Gmail we have the X-GM-RAW extension, which lets us
  // push the whole text/from/to/subject query through Gmail's full-text
  // index in one server-side hop instead of stitching together several IMAP
  // SEARCH criteria that each hit the message store linearly.
  dialect?: "gmail" | "generic";
}

export function compileFilter(filter: Filter, opts: CompileOpts = {}): ImapSearch {
  if ("operator" in filter) {
    if (filter.operator === "AND") {
      return mergeAnd(filter.conditions.map((c) => compileFilter(c, opts)));
    }
    if (filter.operator === "OR") {
      return { or: filter.conditions.map((c) => compileFilter(c, opts)) };
    }
    if (filter.operator === "NOT") {
      return { not: { or: filter.conditions.map((c) => compileFilter(c, opts)) } };
    }
  }
  return compileLeaf(filter as FilterCondition, opts);
}

// A SearchObject carries each key once, so two conditions on the same key
// cannot simply be merged: the second would replace the first. Gmail X-GM-RAW
// terms are joined into one string, which is how it ANDs them; anything else
// goes out as A AND B = NOT (NOT A OR NOT B), which imapflow compiles.
function mergeAnd(parts: ImapSearch[]): ImapSearch {
  const values = new Map<string, unknown[]>();
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      const seen = values.get(k) ?? [];
      if (!seen.some((x) => JSON.stringify(x) === JSON.stringify(v))) seen.push(v);
      values.set(k, seen);
    }
  }
  const out: ImapSearch = {};
  const negated: ImapSearch[] = [];
  for (const [k, vs] of values) {
    if (vs.length === 1) out[k] = vs[0];
    else if (k === "gmraw") out[k] = vs.join(" ");
    else if (k === "not") for (const v of vs) negated.push(...orTerms(v as ImapSearch));
    else for (const v of vs) negated.push({ not: { [k]: v } });
  }
  if (negated.length > 0) {
    if (out.not !== undefined) negated.push(...orTerms(out.not as ImapSearch));
    out.not = { or: negated };
  }
  return out;
}

/** The alternatives of a lone `or`, so that nested ones stay flat. */
function orTerms(s: ImapSearch): ImapSearch[] {
  return Object.keys(s).length === 1 && Array.isArray(s.or) ? (s.or as ImapSearch[]) : [s];
}

function compileLeaf(c: FilterCondition, opts: CompileOpts): ImapSearch {
  const out: ImapSearch = {};
  const gmail = opts.dialect === "gmail";
  if (c.before) out.before = new Date(c.before);
  if (c.after) out.since = new Date(c.after);
  if (c.minSize != null) out.larger = c.minSize - 1;
  if (c.maxSize != null) out.smaller = c.maxSize + 1;
  // System keywords ($seen/$flagged/$answered/$draft) map to dedicated IMAP
  // SEARCH criteria. Some servers (notably Dovecot) reject `KEYWORD \Seen`
  // because the special-use flags aren't keywords in their model. Custom
  // keywords still go through KEYWORD/UNKEYWORD.
  if (c.hasKeyword) applyKeywordSearch(out, c.hasKeyword, true);
  if (c.notKeyword) applyKeywordSearch(out, c.notKeyword, false);
  if (c.text) {
    if (gmail) {
      // Gmail's X-GM-RAW understands the same operators its web UI does;
      // the user's typed terms go through verbatim and hit the index.
      out.gmraw = quoteGmail(c.text);
    } else {
      // JMAP `text` matches across from/to/cc/bcc/subject/body — IMAP TEXT,
      // not BODY. Multi-word queries become per-token TEXT criteria ANDed
      // together; otherwise the server hunts for the literal string (incl.
      // spaces and *), scans the whole mailbox, and returns nothing.
      Object.assign(out, compileTextTokens(c.text));
    }
  }
  if (c.from) gmail ? appendGmRaw(out, `from:${quoteGmail(c.from)}`) : (out.from = c.from);
  if (c.to) gmail ? appendGmRaw(out, `to:${quoteGmail(c.to)}`) : (out.to = c.to);
  if (c.cc) gmail ? appendGmRaw(out, `cc:${quoteGmail(c.cc)}`) : (out.cc = c.cc);
  if (c.bcc) gmail ? appendGmRaw(out, `bcc:${quoteGmail(c.bcc)}`) : (out.bcc = c.bcc);
  if (c.subject)
    gmail
      ? appendGmRaw(out, `subject:${quoteGmail(c.subject)}`)
      : (out.subject = c.subject);
  if (c.body) gmail ? appendGmRaw(out, quoteGmail(c.body)) : Object.assign(out, mergeAnd([out, compileTextTokens(c.body, "body")]));
  if (c.header) {
    const [name, value] = c.header;
    out.header = { [name]: value ?? "" };
  }
  if (c.hasAttachment != null) {
    if (gmail) {
      // Gmail indexes attachment presence; flip it into the same X-GM-RAW
      // query so we still get one round trip on the server's index.
      appendGmRaw(out, c.hasAttachment ? "has:attachment" : "-has:attachment");
    }
    // Non-gmail backends: silently ignore here. emailQuery post-filters the
    // SEARCH results against bodyStructure to honor the filter without
    // server support.
  }
  return out;
}

function appendGmRaw(out: ImapSearch, term: string): void {
  out.gmraw = out.gmraw ? `${out.gmraw} ${term}` : term;
}

const SYSTEM_KEYWORD_SEARCH: Record<string, [string, string]> = {
  $seen:     ["seen", "unseen"],
  $flagged:  ["flagged", "unflagged"],
  $answered: ["answered", "unanswered"],
  $draft:    ["draft", "undraft"],
};

function applyKeywordSearch(out: ImapSearch, keyword: string, has: boolean): void {
  const sys = SYSTEM_KEYWORD_SEARCH[keyword];
  if (sys) {
    const [pos, neg] = sys;
    out[has ? pos : neg] = true;
    return;
  }
  // Custom keywords route through the generic KEYWORD/UNKEYWORD criteria.
  if (has) out.keyword = keywordToFlag(keyword);
  else out.unKeyword = keywordToFlag(keyword);
}

// Wrap a value in quotes if it contains whitespace or Gmail operator chars.
// Gmail accepts `"foo bar"` literally; bare strings work for single tokens.
function quoteGmail(s: string): string {
  if (/[\s":()]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function compileTextTokens(s: string, key: "text" | "body" = "text"): ImapSearch {
  // RFC 8621 §4.4.1: a quoted part is one phrase, every other word a token,
  // and all of them must match. IMAP SEARCH does substring matching with no
  // wildcard support; `*` and `?` would be sent literally and never match, as
  // would the quotes.
  const tokens = [...s.matchAll(/"([^"]*)"|[^\s"]+/g)]
    .map(([all, phrase]) => (phrase !== undefined ? phrase.trim() : all.replace(/[*?]/g, "")))
    .filter(Boolean);
  if (tokens.length === 0) return {};
  return mergeAnd(tokens.map((t) => ({ [key]: t })));
}
