// The bot computer over HTTP: its state, turning it on and off, a bot's screen,
// and the viewer's WebSocket. Only the RFB stream crosses the container
// boundary: the viewer page is bundled with the app, never served by the container.
import { createHash } from "node:crypto";
import { request, ServerResponse, type IncomingMessage, type Server } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { ComputerHost } from "../colonie/computer/computer-host.ts";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const SCREEN = /^\/api\/computer\/screens\/([\w-]{1,80})(\/websockify|\/take|\/hand-back)?$/;
const GATE = "/api/internal/computer-gate";
const HANDSHAKE_MS = 10_000;
const RECHECK_MS = 5_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface Upgrade { socket: Socket; head: Buffer; release: () => void; close: () => void }

export function createComputerRoutes(deps: {
  host: ComputerHost;
  botExists: (botId: string) => boolean;
  /** The session behind this request is still signed in. */
  live: (auth: RequestAuth) => boolean;
}) {
  const { host } = deps;
  const upgrades = new Map<IncomingMessage, Upgrade>();
  /** Open viewers per bot: a person who takes over keeps the screen only while one is looking at it. */
  const viewers = new Map<string, number>();
  let stopped = false;

  /** Upgrades run through the same authentication and gates as HTTP; only this route detaches the socket. */
  function attach(server: Server, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>): void {
    server.on("upgrade", (req, socket, head) => {
      if (stopped || !(socket instanceof Socket)) { socket.destroy(); return; }
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      res.setHeader("connection", "close");
      socket.on("error", () => socket.destroy());
      res.once("finish", () => socket.end(() => socket.destroy()));
      let path: string;
      try { path = new URL(req.url ?? "", "http://localhost").pathname; }
      catch { res.writeHead(400).end(); return; }
      if (SCREEN.exec(path)?.[2] !== "/websockify") { res.writeHead(404).end(); return; }
      const upgrade: Upgrade = { socket, head, release: () => socket.off("data", buffer), close: () => socket.destroy() };
      const buffer = (data: Buffer) => {
        if (upgrade.head.length + data.length > 64 * 1024) socket.destroy();
        else upgrade.head = Buffer.concat([upgrade.head, data]);
      };
      socket.on("data", buffer);
      socket.once("end", () => socket.destroy());
      socket.once("close", () => { upgrade.release(); upgrades.delete(req); });
      upgrades.set(req, upgrade);
      const timeout = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
      timeout.unref();
      socket.once("close", () => clearTimeout(timeout));
      void handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else socket.destroy();
      }).finally(() => clearTimeout(timeout));
    });
  }

  const route: RouteHandler = async ({ req, res, path, method, auth, json }) => {
    if (path === GATE) {
      // The screen's own tools ask this before each call (a loopback bridge, not a person).
      res.setHeader("cache-control", "private, no-store");
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const bearer = /^Bearer (\S{20,200})$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const state = bearer ? host.gate(bearer) : undefined;
      if (!state) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { held: state.taken, helpOpen: false });
    }
    if (path === "/api/computer" || path === "/api/computer/on" || path === "/api/computer/off" || SCREEN.test(path)) {
      res.setHeader("cache-control", "private, no-store");
      // These start containers and hand out a live desktop: the owner only.
      if (!auth.scopes.includes("admin") || (method !== "GET" && !isSameOrigin(req)) || (SCREEN.exec(path)?.[2] && !isSameOrigin(req))) {
        return json(res, 403, { error: "forbidden" });
      }
    }
    if (path === "/api/computer") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, await host.view());
    }
    if (path === "/api/computer/on") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      // Preparing the image takes minutes: answer now, the panel watches the state.
      try { void host.turnOn().catch(() => undefined); } catch { /* the state says why */ }
      return json(res, 202, await host.view());
    }
    if (path === "/api/computer/off") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      await host.turnOff();
      return json(res, 200, await host.view());
    }
    const match = SCREEN.exec(path);
    if (!match) return PASS;
    const botId = match[1]!;
    if (!deps.botExists(botId)) return json(res, 404, { error: "no such bot" });
    if (match[2] === "/take" || match[2] === "/hand-back") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      // a hold lasts as long as a viewer is open (the last one closing hands it back), so take needs one
      if (match[2] === "/take" && !viewers.get(botId)) return json(res, 409, { error: "Open the screen first, then take over." });
      try { if (match[2] === "/take") host.takeOver(botId); else host.handBack(botId); }
      catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "could not change who is driving" }); }
      return json(res, 200, await host.view());
    }
    if (!match[2]) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      try { await host.screen(botId); }
      catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 502;
        return json(res, status, { error: error instanceof Error ? error.message : "could not open the screen" });
      }
      return json(res, 200, { ok: true });
    }
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const upgrade = upgrades.get(req);
    if (!upgrade) return json(res, 426, { error: "WebSocket upgrade required" });
    const target = await host.viewer(botId);
    if (!target) return json(res, 409, { error: "This screen is not open. Open it again from Colonie." });
    if (res.destroyed || upgrade.socket.destroyed) return;
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13"
      || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      return json(res, 400, { error: "Invalid WebSocket handshake" });
    }
    // noVNC asks for the "binary" subprotocol and a browser drops a connection whose
    // answer does not name one: offer upstream what the client offered, say back what it chose.
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => /^[\w.-]{1,40}$/.test(entry)).slice(0, 4);
    const live = () => deps.live(auth) && host.holds(botId);
    if (!live()) return json(res, 401, { error: "Viewer access expired" });
    // Fixed host and path; the port is the container's own published one and the
    // token never leaves the server. No cookie, header or query is forwarded.
    const upstream = request({
      hostname: "127.0.0.1", port: target.port, path: `/websockify?token=${encodeURIComponent(target.token)}`,
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", ...(offered.length ? { "Sec-WebSocket-Protocol": offered.join(", ") } : {}) },
    });
    const { socket } = upgrade;
    let peer: Duplex | undefined;
    let recheck: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const timeout = setTimeout(() => fail(), HANDSHAKE_MS);
    timeout.unref();
    let counted = false;
    upgrade.close = () => {
      if (closed) return;
      closed = true;
      if (counted) {
        const left = (viewers.get(botId) ?? 1) - 1;
        if (left > 0) viewers.set(botId, left);
        else { viewers.delete(botId); host.handBack(botId); }
      }
      clearTimeout(timeout);
      clearInterval(recheck);
      upstream.destroy();
      peer?.destroy();
      socket.destroy();
    };
    const fail = () => {
      if (closed) return;
      if (peer || socket.destroyed) { upgrade.close(); return; }
      if (!res.headersSent && !socket.destroyed) json(res, 502, { error: "Could not connect to the screen" });
      upstream.destroy();
    };
    socket.once("close", upgrade.close);
    upstream.once("error", fail);
    upstream.once("response", (answer) => { answer.resume(); fail(); });
    upstream.once("upgrade", (answer, remote, remoteHead) => {
      const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (!live() || socket.destroyed || answer.headers["sec-websocket-accept"] !== accept
        || answer.headers.upgrade?.toLowerCase() !== "websocket") {
        remote.destroy(); fail(); return;
      }
      clearTimeout(timeout);
      peer = remote;
      counted = true;
      viewers.set(botId, (viewers.get(botId) ?? 0) + 1);
      remote.once("error", upgrade.close);
      remote.once("close", upgrade.close);
      upgrade.release();
      res.detachSocket(socket);
      const chosen = String(answer.headers["sec-websocket-protocol"] ?? "").trim();
      const protocol = offered.includes(chosen) ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : "";
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (upgrade.head.length) remote.write(upgrade.head);
      upgrade.head = Buffer.alloc(0);
      socket.pipe(remote).pipe(socket);
      host.touch();
      recheck = setInterval(() => { if (!live()) upgrade.close(); else host.touch(); }, RECHECK_MS);
      recheck.unref();
    });
    upstream.end();
  };

  return {
    route, attach,
    closeAll: () => { stopped = true; for (const upgrade of upgrades.values()) upgrade.close(); },
  };
}
