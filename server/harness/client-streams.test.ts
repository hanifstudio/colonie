// The server-side client push: what a store change broadcasts, how frames are
// numbered for resume, how a member's copy of a frame is narrowed, and how a
// revoked session's streams are closed. The cases here drive the module with
// fake clients and a fake sequence counter, so they pin the fan-out decisions
// without an HTTP server.
import { expect, test } from "vitest";
import { createClientStreams, type ClientStreamsDeps } from "./client-streams.ts";

interface FakeClient {
  admin: boolean;
  viewer: { kind: string };
  screens: boolean;
  sessionId: string;
  seen: { bots: Set<string> };
  backpressured: boolean;
  res: { write: (chunk: string) => boolean; end: () => void; writableLength: number; once: () => void };
  writes: string[];
  ended: boolean;
}

function fakeClient(over: Partial<FakeClient> = {}): FakeClient {
  const client: FakeClient = {
    admin: false,
    viewer: { kind: "all" },
    screens: true,
    sessionId: "s1",
    seen: { bots: new Set() },
    backpressured: false,
    res: {
      write: (chunk) => { client.writes.push(chunk); return true; },
      end: () => { client.ended = true; },
      writableLength: 0,
      once: () => {},
    },
    writes: [],
    ended: false,
    ...over,
  };
  return client;
}

function harness(over: Record<string, unknown> = {}) {
  let seq = 0;
  let at = -1;
  let onChange: ((change: any) => void) | undefined;
  const browserClosed: string[] = [];
  const deps: Record<string, unknown> = {
    DEFAULT_PAGE: 0,
    commandAllowlist: { clear: () => {} },
    computerControl: { ownsLease: () => false },
    directRequestOwners: new Map(),
    forgetVisibility: () => {},
    messagePage: () => ({}),
    publicBotQueuedMessages: () => ({}),
    routines: () => undefined,
    slimMessage: (message: unknown) => message,
    store: { bots: [], onChange: (cb: (change: any) => void) => { onChange = cb; } },
    syncRoutineRunToSource: () => () => {},
    wireBot: (bot: unknown) => bot,
    botComputerControlKey: () => () => "key",
    browserLive: { closeForOwner: (owner: string) => { browserClosed.push(owner); } },
    cfg: {},
    lastSeq: () => seq,
    setLastSeq: (value: number) => { seq = value; },
    localVmIdleFor: () => () => ({ touch: () => {} }),
    localVmTargetForStatus: () => () => ({ key: "k" }),
    sessions: { isLive: () => true, revalidateEmailSessions: () => {} },
    configForAccess: () => (payload: unknown) => payload,
    configStatus: () => ({}),
    memberFrameContext: (visible: unknown) => ({ visible }),
    visibleTo: () => ({ everything: true }),
    setAudienceChangedAt: (value: number) => { at = value; },
    ...over,
  };
  const api = createClientStreams(deps as unknown as ClientStreamsDeps);
  return { ...api, browserClosed, onChange: () => onChange, sequence: () => seq, audienceAt: () => at };
}

test("broadcast numbers every frame and keeps it for replay", () => {
  const h = harness();
  const admin = fakeClient({ admin: true });
  h.sseClients.add(admin as never);
  h.broadcast({ kind: "message", threadId: "t" });
  h.broadcast({ kind: "bot.queued", queues: {} });
  expect(admin.writes).toHaveLength(2);
  expect(admin.writes[0]).toContain(`id: ${h.STREAM_ID}:1`);
  expect(admin.writes[1]).toContain(`id: ${h.STREAM_ID}:2`);
  expect(admin.writes[1]).toContain('"seq":2');
  expect(h.replayBuffer.map((row) => row.seq)).toEqual([1, 2]);
  expect(h.sequence()).toBe(2);
});

test("an admin-only frame never reaches a member", () => {
  const h = harness();
  const admin = fakeClient({ admin: true });
  const member = fakeClient();
  h.sseClients.add(admin as never);
  h.sseClients.add(member as never);
  h.broadcast({ kind: "notify" }, { adminOnly: true });
  expect(admin.writes).toHaveLength(1);
  expect(member.writes).toHaveLength(0);
  // The replay copy is kept too, so a reconnect is answered admin-only.
  expect(h.replayBuffer).toHaveLength(1);
});

test("a member frame is narrowed, or withdrawn, by what the member may see", () => {
  const h = harness();
  const all = fakeClient({ viewer: { kind: "all" } });
  expect(h.memberFrame(all as never, 1, { kind: "message", threadId: "t" }, "FRAME")).toBe("FRAME");
  // A kept frame stays kept: never the admin copy.
  expect(h.memberFrame(all as never, 1, { kind: "message" }, null)).toBeNull();

  // A restricted member gets the frame only for a thread it can see.
  const restricted = harness({
    visibleTo: () => ({ everything: false, sections: (s: string[]) => s, thread: (id: string) => id === "visible", bot: () => false }),
  });
  const member = fakeClient({ viewer: { kind: "member" } });
  expect(restricted.memberFrame(member as never, 1, { kind: "message", threadId: "visible" }, "FRAME")).toBe("FRAME");
  expect(restricted.memberFrame(member as never, 1, { kind: "message", threadId: "hidden" }, "FRAME")).toBeNull();
});

test("audienceChanged marks the frame and ends only member streams", () => {
  const h = harness();
  const member = fakeClient({ viewer: { kind: "member" } });
  const admin = fakeClient({ admin: true, viewer: { kind: "all" } });
  h.sseClients.add(member as never);
  h.sseClients.add(admin as never);
  h.broadcast({ kind: "message" });
  h.audienceChanged();
  expect(h.audienceAt()).toBe(1);
  expect(member.ended).toBe(true);
  expect(admin.ended).toBe(false);
  expect(h.sseClients.has(member as never)).toBe(false);
});

test("a cursor is only trusted from this run's stream", () => {
  const h = harness();
  expect(h.cursorSeq(`${h.STREAM_ID}:3`)).toBe(3);
  expect(h.cursorSeq([`${h.STREAM_ID}:5`])).toBe(5);
  expect(h.cursorSeq("other-run:3")).toBeNull();
  expect(h.cursorSeq(`${h.STREAM_ID}:-1`)).toBeNull();
  expect(h.cursorSeq(undefined)).toBeNull();
});

test("closing one session's streams leaves the others open", () => {
  const h = harness();
  const mine = fakeClient({ sessionId: "s1" });
  const theirs = fakeClient({ sessionId: "s2" });
  h.sseClients.add(mine as never);
  h.sseClients.add(theirs as never);
  h.closeSessionStreams("s1");
  expect(mine.ended).toBe(true);
  expect(theirs.ended).toBe(false);
  expect(h.browserClosed).toEqual(["s1"]);
  expect(h.sseClients.has(mine as never)).toBe(false);
  expect(h.sseClients.has(theirs as never)).toBe(true);
});
