// A mail server that leaves full-text searches unanswered (seen: both bulk
// connections silent for the five minutes of imapflow's inactivity limit, all
// ten requests of the account stuck behind them and every further one refused).
// Boots the real server against an IMAP server on 127.0.0.1.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { bootProxy, type FakeImap } from "./fake-imap.js";

const FOLDERS = ["INBOX", "Archive", "Projects", "Receipts"];
let server: net.Server;
let app: FastifyInstance;
let dir: string;
let url = "";
let accountId = "";
/** Connections with an unanswered full-text search, now and at most. */
const silent = { now: 0, most: 0, total: 0 };
let answerText = false;

beforeAll(async () => {
  process.env.IMAP_SEARCH_TIMEOUT_MS = "1500";
  process.env.IMAP_POOL_WAIT_MS = "1000";
  server = net.createServer((sock) => {
    let waiting = false;
    sock.on("error", () => {});
    sock.on("close", () => { if (waiting) silent.now--; });
    sock.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] hi\r\n");
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("latin1");
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const [tag, a, b] = line.split(" ");
        if (!tag || !a) continue;
        const cmd = (a === "UID" ? b! : a).toUpperCase();
        if (cmd === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK\r\n`);
        else if (cmd === "LIST") sock.write(FOLDERS.map((f) => `* LIST (\\HasNoChildren) "/" ${f}\r\n`).join("") + `${tag} OK\r\n`);
        else if (cmd === "STATUS") sock.write(`* STATUS ${b} (MESSAGES 1 UNSEEN 0 UIDNEXT 2 UIDVALIDITY 1)\r\n${tag} OK\r\n`);
        else if (cmd === "SELECT" || cmd === "EXAMINE") sock.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] x\r\n* OK [UIDNEXT 2] x\r\n${tag} OK [READ-WRITE] x\r\n`);
        else if (cmd === "SEARCH" && /TEXT/.test(line) && !answerText) {
          waiting = true;
          silent.total++;
          silent.most = Math.max(silent.most, ++silent.now);
        } else if (cmd === "SEARCH") sock.write(`* SEARCH 1\r\n${tag} OK\r\n`);
        else if (cmd === "FETCH") sock.write(`* 1 FETCH (UID 1 INTERNALDATE "01-Jan-2026 00:00:00 +0000")\r\n${tag} OK\r\n`);
        else if (cmd === "LOGOUT") sock.end(`* BYE\r\n${tag} OK\r\n`);
        else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  ({ app, dir } = await bootProxy({ port: (server.address() as net.AddressInfo).port } as FakeImap));
  for (let i = 0; !app.server.listening && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
  url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  const session = await app.inject({ url: "/jmap/session", headers: { authorization: AUTH } });
  accountId = Object.keys(session.json().accounts)[0]!;
}, 30_000);
afterAll(async () => {
  delete process.env.IMAP_SEARCH_TIMEOUT_MS;
  delete process.env.IMAP_POOL_WAIT_MS;
  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const allClosed = async () => {
  for (let i = 0; silent.now > 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
  return silent.now === 0;
};
beforeEach(async () => {
  await allClosed();
  answerText = false;
  Object.assign(silent, { most: 0, total: 0 });
});

const AUTH = `Basic ${Buffer.from("u@test.local:pw").toString("base64")}`;
const body = (name: string, args: object) =>
  JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [[name, { accountId, ...args }, "0"]] });
const call = async (name: string, args: object) => {
  const t0 = Date.now();
  const res = await app.inject({ method: "POST", url: "/jmap", headers: { authorization: AUTH, "content-type": "application/json" }, payload: body(name, args) });
  return { status: res.statusCode, ms: Date.now() - t0, call: res.statusCode === 200 ? res.json().methodResponses[0] : null };
};

it("answers folders and keyword queries while several text searches get no answer", async () => {
  const searches = ["one", "two", "three", "four"].map((text) => call("Email/query", { filter: { text } }));
  await new Promise((r) => setTimeout(r, 300));
  const others = await Promise.all([call("Mailbox/get", { ids: null }), call("Email/query", { filter: { hasKeyword: "$seen" } }), call("Thread/get", { ids: [] })]);
  for (const o of others) {
    expect(o.status).toBe(200);
    expect(o.call[0]).not.toBe("error");
    expect(o.ms).toBeLessThan(1400);
  }
  expect(silent.most).toBe(1);
  // Each search ends as an error, never as a result without hits.
  for (const s of await Promise.all(searches)) expect(s.call[0]).toBe("error");
  // One folder each: the first failure ends a search.
  expect(silent.total).toBe(4);
  expect(await allClosed()).toBe(true);
}, 30_000);

it("works again, with every hit, once the server answers", async () => {
  answerText = true;
  const r = await call("Email/query", { filter: { text: "one" }, calculateTotal: true });
  expect(r.call[0]).toBe("Email/query");
  expect(r.call[1].total).toBe(4);
});

it("searches one folder for text without an interactive connection", async () => {
  const boxes = (await call("Mailbox/get", { ids: null })).call[1].list as { id: string; name: string }[];
  const inMailbox = boxes.find((b) => b.name === "Archive")!.id;
  const searches = [1, 2, 3].map((n) => call("Email/query", { filter: { operator: "AND", conditions: [{ inMailbox }, { text: `t${n}` }] } }));
  await new Promise((r) => setTimeout(r, 300));
  const list = await call("Email/query", { filter: { inMailbox } });
  expect(list.call[1].ids).toHaveLength(1);
  expect(list.ms).toBeLessThan(1000);
  for (const s of await Promise.all(searches)) expect(s.call[0]).toBe("error");
}, 30_000);

it("ends a search, and its connection, when the browser closes the request", async () => {
  process.env.IMAP_SEARCH_TIMEOUT_MS = "20000";
  const req = http.request(`${url}/jmap`, { method: "POST", headers: { authorization: AUTH, "content-type": "application/json" } });
  req.on("error", () => {});
  req.end(body("Email/query", { filter: { text: "closed" } }));
  for (let i = 0; silent.now === 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
  expect(silent.now).toBe(1);
  req.destroy();
  expect(await allClosed()).toBe(true);
  expect(silent.total).toBe(1);
  process.env.IMAP_SEARCH_TIMEOUT_MS = "1500";
}, 30_000);
