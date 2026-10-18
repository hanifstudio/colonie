// The event stream is the one response that never ends, so this guards the two
// things that must be true the moment it opens: it says hello once with an
// honest "resumed", and the client is in the fan-out — and out of it again when
// the socket closes. What a resume actually replays is proven live instead.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createEventRoutes, type EventRouteDeps, type SseClient } from "./events.ts";

const EVENTS = "/api/events";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const clients = new Set<SseClient>();
  const fake = {
    store: { bots: [], groups: [] },
    sessions: { isLive: () => true },
    sseClients: clients,
    replayBuffer: [],
    lastSeq: () => 7,
    audienceChangedAt: () => 0,
    streamId: "abc",
    heartbeatMs: 60_000,
    cursorSeq: () => null,
    viewerFor: () => ({ kind: "all" }),
    visibleTo: () => ({ bot: () => true, group: () => true }),
    wants: () => true,
    memberFrame: () => null,
    ...over,
  } as unknown as EventRouteDeps;
  return { deps: fake, clients };
};

const drive = async (path = EVENTS, method = "GET", headers: Record<string, string> = {}) => {
  const frames: string[] = [];
  const onClose: Array<() => void> = [];
  const { ctx, sent } = callRoute(path, method, {}, headers);
  (ctx as { req: unknown }).req = {
    headers,
    socket: { setTimeout: () => {} },
    on: (event: string, cb: () => void) => {
      if (event === "close") onClose.push(cb);
    },
    resume: () => {},
  };
  (ctx.res as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };
  const out = await createEventRoutes(deps().deps)(ctx);
  return { out, sent, frames, onClose, clients: deps().clients };
};

test("another route is left to the next handler", async () => {
  const { out, sent } = await drive("/api/health", "GET");

  expect(out).toBe(PASS);
  expect(sent).toEqual([]);
});

test("opening a stream says hello once and joins the fan-out, and closing leaves it", async () => {
  const { deps: fake, clients } = deps();
  const frames: string[] = [];
  const onClose: Array<() => void> = [];
  const { ctx } = callRoute(EVENTS, "GET", {}, {});
  (ctx as { req: unknown }).req = {
    headers: {},
    socket: { setTimeout: () => {} },
    on: (event: string, cb: () => void) => {
      if (event === "close") onClose.push(cb);
    },
    resume: () => {},
  };
  (ctx.res as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };

  const out = await createEventRoutes(fake)(ctx);

  expect(out).not.toBe(PASS);
  expect(clients.size).toBe(1);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toContain('"kind":"hello"');
  // No cursor was offered, so nothing could be resumed — and the app is told so.
  expect(frames[0]).toContain('"resumed":false');
  expect(frames[0]).toContain('"cursor":"abc:7"');

  for (const close of onClose) close();
  expect(clients.size).toBe(0);
});