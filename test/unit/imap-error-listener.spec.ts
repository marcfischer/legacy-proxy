// A connection error on an ImapFlow nobody listens to is thrown from a timer
// and reaches process.on("uncaughtException"). openImap must give every client
// a listener, the auth probes included.

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openImap } from "../../src/imap/client.js";

let server: net.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function startServer(): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    sock.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = ""] = line.split(" ");
        if (cmd.toUpperCase() === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else sock.write(`${tag} OK\r\n`);
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

describe("openImap", () => {
  it("leaves no client without an error listener", async () => {
    server = await startServer();
    const port = (server.address() as net.AddressInfo).port;
    const client = await openImap({
      provider: { imap: { host: "127.0.0.1", port, secure: false } } as never,
      creds: { mech: "PLAIN", username: "u", password: "p" },
    });
    try {
      expect(() => client.emit("error", new Error("Socket timeout"))).not.toThrow();
    } finally {
      client.close();
    }
  });
});
