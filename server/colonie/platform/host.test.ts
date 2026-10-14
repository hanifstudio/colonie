import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { platformRequestAllowed } from "./host.ts";
import { readPlatformAuthBody } from "./auth.ts";
import { createServer, request } from "node:http";

describe("public Cloud entry boundaries", () => {
  const publicOrigin = "https://172.104.33.55";
  const localOrigin = "http://127.0.0.1:19091";
  const incoming = (path: string, method = "GET", extra = {}) => ({ url: path, method, headers: { host: "172.104.33.55", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", ...extra } }) as IncomingMessage;
  it("accepts top-level invitation/OAuth pages reached from other sites", () => {
    expect(platformRequestAllowed(incoming("/invite/fixture"), publicOrigin, localOrigin)).toBe(true);
    expect(platformRequestAllowed(incoming("/composio/callback?session_uri=synthetic"), publicOrigin, localOrigin)).toBe(true);
  });
  it("refuses cross-site APIs, writes and embedded requests", () => {
    expect(platformRequestAllowed(incoming("/api/colonie/auth/get-session"), publicOrigin, localOrigin)).toBe(false);
    expect(platformRequestAllowed(incoming("/composio/callback", "POST"), publicOrigin, localOrigin)).toBe(false);
    expect(platformRequestAllowed(incoming("/invite/fixture", "GET", { "sec-fetch-dest": "iframe" }), publicOrigin, localOrigin)).toBe(false);
    expect(platformRequestAllowed(incoming("/", "GET", { origin: "https://foreign.example.test" }), publicOrigin, localOrigin)).toBe(false);
    expect(platformRequestAllowed(incoming("/", "GET", { host: "foreign.example.test" }), publicOrigin, localOrigin)).toBe(false);
  });
  it("refuses an oversized chunked account body without destroying the response socket", async () => {
    const server = createServer(async (req, res) => {
      try { await readPlatformAuthBody(req); res.writeHead(200); }
      catch (error) { res.writeHead((error as { status: number }).status); }
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const port = (server.address() as { port: number }).port;
      const status = await new Promise<number>((done, fail) => {
        const req = request({ hostname: "127.0.0.1", port, path: "/synthetic-account", method: "POST", headers: { "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => done(res.statusCode!)); });
        req.on("error", fail);
        req.write(Buffer.alloc(70_000)); req.end(Buffer.alloc(70_000));
      });
      expect(status).toBe(413);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
