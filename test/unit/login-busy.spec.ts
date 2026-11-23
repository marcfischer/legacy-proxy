// A login the mail server turns away for now (NO [LIMIT]) is answered 503 with
// Retry-After, not 401: the webmail takes a 401 as a wrong password and signs
// the user out. Boots the real server against an IMAP server on 127.0.0.1.

import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { bootProxy, type FakeImap } from "./fake-imap.js";

let answer = "";
let server: net.Server;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] hi\r\n");
    sock.on("data", (c) => {
      for (const line of c.toString("latin1").split("\r\n")) {
        const [tag, cmd] = line.split(" ");
        if (!tag || !cmd) continue;
        if (/^(AUTHENTICATE|LOGIN)$/i.test(cmd)) sock.write(`${tag} ${answer}\r\n`);
        else if (/^LOGOUT$/i.test(cmd)) sock.end(`* BYE\r\n${tag} OK\r\n`);
        else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  ({ app, dir } = await bootProxy({ port: (server.address() as net.AddressInfo).port } as FakeImap));
});
afterAll(async () => {
  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const basic = () =>
  app.inject({ url: "/jmap/session", headers: { authorization: `Basic ${Buffer.from("u@test.local:pw").toString("base64")}` } });
const login = () => app.inject({ method: "POST", url: "/api/login", payload: { username: "u@test.local", password: "pw" } });

it("answers 503 with Retry-After when the server has no connection left", async () => {
  answer = "NO [LIMIT] Maximum number of connections from user+IP exceeded";
  for (const res of [await basic(), await login()]) {
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    // The mail server's own words stay in the log.
    expect(res.body).not.toContain("user+IP");
  }
});

it("still answers 401 to a refused password", async () => {
  answer = "NO [AUTHENTICATIONFAILED] no";
  expect((await basic()).statusCode).toBe(401);
  expect((await login()).statusCode).toBe(401);
});
