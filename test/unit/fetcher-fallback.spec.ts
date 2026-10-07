import { describe, expect, it } from "vitest";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";

const SOURCE = Buffer.from(
  [
    "From: Hotel <noreply@example.com>",
    "To: me@example.org",
    "Subject: Your stay",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Gr=C3=BC=C3=9Fe aus Frankfurt",
    "--b",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Welcome</p>",
    "--b--",
    "",
  ].join("\r\n"),
);

// Answers BODY[1]/BODY[2] with empty literals, like the server in the field,
// but serves the full message on BODY[].
function fakeClient(sourceAvailable: boolean) {
  return {
    async *fetch(_set: string, query: Record<string, unknown>) {
      if (query.bodyStructure) {
        yield {
          uid: 7,
          flags: new Set<string>(),
          size: SOURCE.length,
          internalDate: new Date(0),
          envelope: { subject: "Your stay" },
          headers: Buffer.alloc(0),
          bodyStructure: {
            type: "multipart/alternative",
            childNodes: [
              { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "quoted-printable", size: 30 },
              { part: "2", type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit", size: 14 },
            ],
          },
        };
      } else if (query.bodyParts) {
        yield { uid: 7, bodyParts: new Map([["1", Buffer.alloc(0)], ["2", Buffer.alloc(0)]]) };
      } else if (query.source) {
        yield { uid: 7, source: sourceAvailable ? SOURCE : Buffer.alloc(0) };
      }
    },
  };
}

const account = { id: 1 } as never;
const mailbox = { id: 2, uidvalidity: 1 } as never;
const opts = { fetchTextBodyValues: true, fetchHTMLBodyValues: true, wantsPreview: true };

describe("body values when the server returns empty parts", () => {
  it("recovers text and html from the full message", async () => {
    const out = await fetchEmailsBatch(fakeClient(true) as never, account, mailbox, [7], opts);
    const email = out.get(7)!;
    expect(email.bodyValues["1"]).toEqual({ value: "Grüße aus Frankfurt", isEncodingProblem: false, isTruncated: false });
    expect(email.bodyValues["2"]!.value).toContain("<p>Welcome</p>");
    expect(email.preview).toBe("Grüße aus Frankfurt");
  });

  it("flags the parts as an encoding problem when the full message is empty too", async () => {
    const out = await fetchEmailsBatch(fakeClient(false) as never, account, mailbox, [7], opts);
    expect(out.get(7)!.bodyValues["1"]).toEqual({ value: "", isEncodingProblem: true, isTruncated: false });
  });
});
