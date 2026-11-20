// ParticipantIdentity tells a calendar client which participant of an event is
// the user. It follows the one mail Identity: same id, name and address.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type AccountRow } from "../../src/state/store.js";
import { identityGet, participantIdentityGet, participantIdentitySet } from "../../src/jmap/methods/identity.js";

let dir: string;
let store: Store;
let account: AccountRow;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pident-"));
  store = new Store(dir);
  store.db
    .prepare(`INSERT INTO account(id, slug, kind, host, username, vault, created_at) VALUES (1, 'imap:m', 'imap', 'imap.example.org', 'marc@example.org', x'00', 0)`)
    .run();
  account = store.db.prepare(`SELECT * FROM account WHERE id = 1`).get() as AccountRow;
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("is the mail identity as a calendar address", async () => {
  store.putIdentitySettings(1, { ...store.getIdentitySettings(1), displayName: "Marc Fischer" });
  const mail = (await identityGet({ accountId: "1", ids: null }, { account, store })).list[0]!;
  const got = participantIdentityGet({ accountId: "1" }, { account, store });
  expect(got.list).toEqual([{ id: mail.id, name: "Marc Fischer", calendarAddress: "mailto:marc@example.org", isDefault: true }]);
  expect(participantIdentityGet({ accountId: "1", ids: ["nope"] }, { account, store })).toMatchObject({ list: [], notFound: ["nope"] });
});

it("accepts making the one identity the default and refuses changes to the set", () => {
  const id = participantIdentityGet({ accountId: "1" }, { account, store }).list[0]!.id;
  expect(participantIdentitySet({ accountId: "1", onSuccessSetIsDefault: id }, { account, store })).toMatchObject({
    notCreated: null,
    notUpdated: null,
    notDestroyed: null,
  });
  const res = participantIdentitySet(
    { accountId: "1", create: { n: { calendarAddress: "mailto:x@example.org" } }, update: { [id]: { name: "x" } }, destroy: ["other"] },
    { account, store },
  );
  expect(res.notCreated).toMatchObject({ n: { type: "forbidden" } });
  expect(res.notUpdated).toMatchObject({ [id]: { type: "forbidden" } });
  expect(res.notDestroyed).toMatchObject({ other: { type: "notFound" } });
  expect(() => participantIdentitySet({ accountId: "1", onSuccessSetIsDefault: "other" }, { account, store })).toThrow();
  expect(() => participantIdentityGet({ accountId: "2" }, { account, store })).toThrow();
});

it("lists the calendar server's other addresses as further identities", () => {
  const got = participantIdentityGet({ accountId: "1" }, { account, store }, ["MARC@example.org", "kontakt@example.org", "invoice@example.org", "kontakt@example.org"]);
  expect(got.list.map((i) => [i.calendarAddress, i.isDefault])).toEqual([
    ["mailto:marc@example.org", true],
    ["mailto:kontakt@example.org", false],
    ["mailto:invoice@example.org", false],
  ]);
  // Ids are stable, so a client's cached identities stay valid.
  const again = participantIdentityGet({ accountId: "1" }, { account, store }, ["invoice@example.org", "kontakt@example.org"]);
  expect(again.list.slice(1).map((i) => i.id).sort()).toEqual(got.list.slice(1).map((i) => i.id).sort());

  const alias = got.list[1]!.id;
  const res = participantIdentitySet({ accountId: "1", destroy: [alias] }, { account, store }, ["kontakt@example.org"]);
  expect(res.notDestroyed).toMatchObject({ [alias]: { type: "forbidden" } });
  expect(() => participantIdentitySet({ accountId: "1", onSuccessSetIsDefault: alias }, { account, store }, ["kontakt@example.org"])).toThrow(/mail login/);
});
