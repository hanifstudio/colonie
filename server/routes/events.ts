// The one long-lived response in the app: the event stream every client
// listens to for bots, rooms, runs and screens. Resuming is judged by what the
// caller may see *now* — a cursor that predates an audience change gets a fresh
// snapshot rather than a replay that could hide or reveal the wrong thing — and
// an expired session is ended at the next heartbeat.
import type { ServerResponse } from "node:http";
import type { StreamSeen, Viewer, VisibleSet } from "../colonie/bots/bot-visibility.ts";
import type { Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** One connected client, and what it asked to be sent. */
export interface SseClient {
  res: ServerResponse;
  admin: boolean;
  /** Live screen frames carry a base64 desktop capture every few seconds
   * while a bot works. A client that isn't showing the computer panel —
   * a phone on cellular, most of all — should not pay for them. */
  screens: boolean;
  /** The paired session behind this stream, when there is one: revoking or
   * expiring it must end the stream, not just future requests. */
  sessionId?: string;
  /** Set once this client's socket has signalled it can't keep up (write()
   * returned false); cleared implicitly once it's disconnected. See
   * ./sse-fanout.ts for what this does to fan-out. */
  backpressured: boolean;
  /** Who is watching, for bot visibility; a member's stream is narrowed to
   * what that person may see once any bot is restricted. */
  viewer: Viewer;
  /** The bots and rooms this stream has been shown (bot-visibility.ts). */
  seen: StreamSeen;
}

export interface EventRouteDeps {
  store: Store;
  sessions: { isLive: (sessionId: string) => boolean };
  /** Live clients, mutated as streams open and close. */
  sseClients: Set<SseClient>;
  /** What happened recently enough to replay, oldest first. */
  replayBuffer: Array<{ seq: number; kind: string; frame: string | null; clientFrame: string | null; payload: Record<string, unknown> | null }>;
  /** Read live: every frame the app sends advances it. */
  lastSeq: () => number;
  /** Read live: set when a bot's audience last changed. */
  audienceChangedAt: () => number;
  streamId: string;
  heartbeatMs: number;
  cursorSeq: (raw: string | string[] | undefined) => number | null;
  viewerFor: (auth: RequestAuth) => Viewer;
  visibleTo: (viewer: Viewer) => VisibleSet;
  wants: (client: SseClient, kind: string) => boolean;
  memberFrame: (client: SseClient, seq: number, payload: Record<string, unknown>, clientFrame: string | null) => string | null;
  /** The frame one stream gets (harness/client-streams.ts); absent: the older admin-or-member split. */
  streamFrame?: (client: SseClient, seq: number, payload: Record<string, unknown> | null, frame: string | null, clientFrame: string | null) => string | null;
}

export function createEventRoutes(deps: EventRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth }) => {
    const {
      store, sessions, sseClients, replayBuffer, lastSeq, audienceChangedAt, streamId,
      heartbeatMs, cursorSeq, viewerFor, visibleTo, wants, memberFrame,
    } = deps;
    if (method === "GET" && path === "/api/events") {
      const viewer = viewerFor(auth);
      const visibleNow = visibleTo(viewer);
      const client: SseClient = {
        res,
        admin: auth.scopes.includes("admin"),
        screens: url.searchParams.get("screens") !== "off",
        backpressured: false,
        viewer,
        // What this person's hydration (GET /api/bots, narrowed the same way) showed them.
        seen: viewer.kind === "all" ? { bots: new Set(), groups: new Set() } : {
          bots: new Set(store.bots.filter((bot) => visibleNow.bot(bot.id)).map((bot) => bot.id)),
          groups: new Set(store.groups.filter((group) => visibleNow.group(group.id)).map((group) => group.id)),
        },
      };
      if (auth.kind === "session") client.sessionId = auth.session.id;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Honoured by nginx-compatible reverse proxies; harmless elsewhere.
        // Remote clients need each frame now, not when a proxy buffer fills.
        "x-accel-buffering": "no",
      });

      // Resume, if the client offered a cursor we can honour. `?since=` is
      // for clients that read the stream by hand; Last-Event-ID is what a
      // browser EventSource sends by itself.
      // Once EventSource has received a numbered frame, its automatic
      // reconnect carries a newer Last-Event-ID even though the original
      // URL may still contain an older manual `since` cursor. Prefer the
      // valid browser cursor or the stale query would replay forever.
      const since =
        cursorSeq(req.headers["last-event-id"]) ??
        cursorSeq(url.searchParams.get("since") ?? undefined);
      // The buffer only reaches so far back. If the client's cursor fell off
      // the end, saying so is the only honest answer — a partial replay
      // would leave a permanent hole in its state.
      const resumed =
        since !== null &&
        since <= lastSeq() &&
        (replayBuffer.length === 0 ? since === lastSeq() : replayBuffer[0].seq <= since + 1) &&
        // A member whose cursor predates a bot's audience change gets a fresh
        // snapshot: a replay is judged by today's audience and could neither
        // withdraw what the change hid nor bring back whole what it showed.
        !(viewer.kind !== "all" && audienceChangedAt() > 0 && since <= audienceChangedAt());
      res.write(
        `data: ${JSON.stringify({
          kind: "hello",
          cursor: `${streamId}:${lastSeq()}`,
          // false means "I could not give you what you missed — hydrate".
          // A client that offered no cursor gets false too, which is exactly
          // what a cold start should do.
          resumed,
        })}\n\n`,
      );
      if (resumed) {
        for (const buffered of replayBuffer) {
          if (buffered.seq <= since || !wants(client, buffered.kind)) continue;
          const frame = deps.streamFrame
            ? deps.streamFrame(client, buffered.seq, buffered.payload, buffered.frame, buffered.clientFrame)
            : client.admin
              ? buffered.frame
              : buffered.payload
                ? memberFrame(client, buffered.seq, buffered.payload, buffered.clientFrame)
                : buffered.clientFrame;
          if (frame) res.write(frame);
        }
      }

      sseClients.add(client);
      // Keep this long-lived response out of socket idle-timeout handling
      // without weakening timeouts for every other API request.
      req.socket.setTimeout(0);
      // A comment keeps intermediaries from idling the connection, while a
      // data frame is visible to EventSource clients and resets their own
      // liveness watchdog. Heartbeats carry no id and never advance replay.
      const keepalive = setInterval(() => {
        // an expired session's stream ends at the next heartbeat
        if (client.sessionId && !sessions.isLive(client.sessionId)) {
          res.end();
          return;
        }
        try {
          res.write(`: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`);
        } catch {}
      }, heartbeatMs);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(client);
      });
      return;
    }
    return PASS;
  };
}
