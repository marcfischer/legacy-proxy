import { describe, expect, it } from "vitest";
import { compileFilter } from "../../src/imap/search.js";

describe("Email/query filter compiler", () => {
  it("compiles a leaf condition", () => {
    expect(compileFilter({ subject: "hello" })).toEqual({ subject: "hello" });
  });
  it("maps JMAP `text` to IMAP TEXT, not BODY", () => {
    // JMAP text searches headers + body; IMAP BODY only searches the body.
    expect(compileFilter({ text: "needle" })).toEqual({ text: "needle" });
  });
  it("tokenizes multi-word `text` into per-token TEXT criteria via De Morgan", () => {
    // IMAP TEXT is substring-match: "Volkswagen News" as a single criterion
    // looks for that literal string and matches nothing. Each token must be its
    // own criterion, ANDed via ¬(¬a ∨ ¬b) since SearchObject can't carry two
    // `text` keys.
    expect(compileFilter({ text: "Volkswagen News" })).toEqual({
      not: { or: [{ not: { text: "Volkswagen" } }, { not: { text: "News" } }] },
    });
  });
  it("strips * and ? wildcards from `text` (IMAP would send them literally)", () => {
    expect(compileFilter({ text: "Volkswagen* News?" })).toEqual({
      not: { or: [{ not: { text: "Volkswagen" } }, { not: { text: "News" } }] },
    });
  });
  it("collapses to a single TEXT when only one token survives wildcard stripping", () => {
    expect(compileFilter({ text: "needle*" })).toEqual({ text: "needle" });
  });
  it("compiles AND as merge", () => {
    expect(
      compileFilter({
        operator: "AND",
        conditions: [{ from: "alice@example.com" }, { hasKeyword: "$flagged" }],
      }),
    ).toEqual({ from: "alice@example.com", flagged: true });
  });
  it("compiles OR", () => {
    const r = compileFilter({
      operator: "OR",
      conditions: [{ subject: "a" }, { subject: "b" }],
    }) as { or: unknown[] };
    expect(r.or).toHaveLength(2);
  });
  it("leaves hasAttachment to Email/query's post-filter on plain IMAP", () => {
    // IMAP SEARCH has no attachment criterion; emailQuery checks bodyStructure instead.
    expect(compileFilter({ subject: "a", hasAttachment: true })).toEqual({ subject: "a" });
    expect(compileFilter({ hasAttachment: true }, { dialect: "gmail" })).toEqual({ gmraw: "has:attachment" });
  });
  it("routes Gmail text through X-GM-RAW", () => {
    expect(compileFilter({ text: "tax 2024" }, { dialect: "gmail" })).toEqual({
      gmraw: '"tax 2024"',
    });
  });
  it("combines Gmail header criteria into a single X-GM-RAW query", () => {
    const r = compileFilter(
      {
        operator: "AND",
        conditions: [{ from: "alice@example.com" }, { subject: "invoice" }],
      },
      { dialect: "gmail" },
    ) as { gmraw: string };
    expect(r.gmraw).toContain("from:alice@example.com");
    expect(r.gmraw).toContain("subject:invoice");
  });
  it("Gmail hasAttachment becomes has:attachment", () => {
    expect(compileFilter({ hasAttachment: true }, { dialect: "gmail" })).toEqual({
      gmraw: "has:attachment",
    });
    expect(compileFilter({ hasAttachment: false }, { dialect: "gmail" })).toEqual({
      gmraw: "-has:attachment",
    });
  });

  it("keeps every condition of an AND on the same key", () => {
    expect(compileFilter({ operator: "AND", conditions: [{ from: "a" }, { from: "b" }] })).toEqual({
      not: { or: [{ not: { from: "a" } }, { not: { from: "b" } }] },
    });
    // Other keys, and conditions that repeat, stay as they are.
    expect(compileFilter({ operator: "AND", conditions: [{ from: "a" }, { subject: "s" }, { from: "a" }] })).toEqual({ from: "a", subject: "s" });
    expect(compileFilter({ operator: "AND", conditions: [{ text: "a b" }, { text: "c d" }, { notKeyword: "$seen" }] })).toEqual({
      unseen: true,
      not: { or: ["a", "b", "c", "d"].map((t) => ({ not: { text: t } })) },
    });
  });

  it("keeps a NOT next to a multi-word text", () => {
    expect(compileFilter({ operator: "AND", conditions: [{ operator: "NOT", conditions: [{ from: "a" }] }, { text: "b c" }] })).toEqual({
      not: { or: [{ from: "a" }, { not: { text: "b" } }, { not: { text: "c" } }] },
    });
  });

  it("takes a quoted part as one phrase, without its quotes", () => {
    expect(compileFilter({ text: '"annual report"' })).toEqual({ text: "annual report" });
    expect(compileFilter({ body: '"annual report" 2026' })).toEqual({
      not: { or: [{ not: { body: "annual report" } }, { not: { body: "2026" } }] },
    });
  });

  it("matches the words of `body` one by one, like those of `text`", () => {
    expect(compileFilter({ body: "invoice" })).toEqual({ body: "invoice" });
    expect(compileFilter({ body: "invoice may" })).toEqual({ not: { or: [{ not: { body: "invoice" } }, { not: { body: "may" } }] } });
  });
});
