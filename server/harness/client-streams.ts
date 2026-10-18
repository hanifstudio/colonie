// The server-side client push, lifted out of index.ts: what a store change broadcasts (which also pages a bot whose active thread moved), the SSE frame numbering and replay buffer, the per-member narrowing of a frame, the desktop viewer manager, and the stream teardown a revoked session uses.
import { frameForMember, noteSeen } from "../colonie/bots/bot-visibility.ts";
import { SHARED_LOCAL_VM_TARGET, containerComputerStatus, perBotLocalVmTarget, poolLocalVmTarget } from "../colonie/computer/container-computer.ts";
import { localDesktopTarget, viewerTargetId } from "../colonie/computer/desktop-viewer-targets.ts";
import { localVmMaxInstances } from "../config.ts";
import { createDesktopViewer } from "../routes/desktop-viewer.ts";
import { type SseClient } from "../routes/events.ts";
import { deliverSseFrame } from "../sse-fanout.ts";
import { randomUUID } from "node:crypto";

/** Everything this cluster reaches in the server; see the header. */
export interface ClientStreamsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
  setAudienceChangedAt: (value: any) => void,
  setLastSeq: (value: any) => void,
}

export function createClientStreams(deps: ClientStreamsDeps) {
  const {
    DEFAULT_PAGE, commandAllowlist, directRequestOwners, forgetVisibility, messagePage,
    publicBotQueuedMessages, routines, slimMessage, store, syncRoutineRunToSource, wireBot,
    botComputerControlKey, browserLive, cfg, computerControl, lastSeq,
    localVmIdleFor, localVmTargetForStatus, sessions, configForAccess, configStatus,
    memberFrameContext, visibleTo, setAudienceChangedAt, setLastSeq
  } = deps;

const sentThreads = new Map<string, string>();
for (const record of store.bots) sentThreads.set(record.id, record.threadId);
function pageIfThreadChanged(id: string, threadId: string) {
  if (sentThreads.get(id) === threadId) return {};
  sentThreads.set(id, threadId);
  return messagePage(threadId, DEFAULT_PAGE);
}
store.onChange((change: any) => {
  // Who owns which thread, and what each member may see, follow the fleet.
  if (change.type !== "message" && change.type !== "message.patch" && change.type !== "thread" && change.type !== "sections") forgetVisibility();
  switch (change.type) {
    case "sections":
      broadcast({ kind: "sections", sections: store.sections });
      break;
    // Live frames never carry screenshot pixels; clients load them by URL.
    case "message":
      broadcast({ kind: "message", threadId: change.threadId, message: slimMessage(change.message) });
      break;
    case "message.patch":
      broadcast({ kind: "message.patch", threadId: change.threadId, message: slimMessage(change.message) });
      break;
    case "thread":
      broadcast({ kind: "thread", threadId: change.threadId, activeLeafId: change.activeLeafId });
      break;
    case "thread.deleted":
      directRequestOwners.delete(change.threadId);
      routines()?.forgetRoutineRequestReceiptsForThread(change.threadId);
      // A deleted destination must not strand an approval in an internal
      // task. Keep each run's snapshot and expose its execution as fallback.
      for (const run of routines()?.listRuns() ?? []) {
        if (run.resultsThreadId === change.threadId || run.sourceThreadId === change.threadId) {
          syncRoutineRunToSource()(run);
        }
      }
      broadcast({ kind: "bot.queued", queues: publicBotQueuedMessages() });
      break;
    case "bot": {
      const bot = store.bot(change.botId);
      if (bot) broadcast({ kind: "bot", bot: { ...wireBot(bot), ...pageIfThreadChanged(bot.id, bot.threadId) } });
      break;
    }
    case "bot.deleted":
      sentThreads.delete(change.botId);
      try { commandAllowlist.clear(change.botId); }
      catch { console.error("[command-allowlist] Could not remove deleted bot's saved rules."); }
      broadcast({ kind: "bot.deleted", botId: change.botId });
      break;
  }
});
// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<SseClient>();
/** A bot's audience changed: end every member stream. Each reconnects at
 * once with its cursor, which now predates the change, so it is answered
 * with a fresh snapshot of exactly what that person may see. Admin and
 * owner streams are untouched. */
function audienceChanged(): void {
  setAudienceChangedAt(lastSeq());
  for (const client of sseClients) {
    if (client.viewer.kind !== "member") continue;
    sseClients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
  }
}
// Cloud boot can revoke sessions before routes are registered. Create the
// viewer manager before installing any revocation callbacks.
const desktopViewer = createDesktopViewer({
  target: (id) => {
    const targets = [SHARED_LOCAL_VM_TARGET, ...store.bots.map((bot: any) => perBotLocalVmTarget(bot.id)),
      ...Array.from({ length: localVmMaxInstances(cfg) }, (_, seat) => poolLocalVmTarget(seat))];
    const target = targets.find(target => viewerTargetId(target) === id);
    return target && localDesktopTarget(target, {
      // A viewer can repair a sick CUA driver; skip desktop health probes.
      status: target => containerComputerStatus(undefined, undefined, target, { probeDesktop: false }),
      touch: target => localVmIdleFor()(target).touch(),
    });
  },
  live: auth => auth.kind === "loopback" || sessions.isLive(auth.session.id),
  // A phone paired with this server directly drives a bot's Local VM through
  // this proxy under its control lease (see the local-computer join route).
  // The lease must hold the bot's computer, and that computer must be the
  // desktop being viewed: a lease on one bot opens no other bot's VM.
  lease: (id, botId, controlLeaseId, threadId) => {
    const bot = store.bot(botId);
    if (!bot || viewerTargetId(localVmTargetForStatus()(bot.id, threadId)) !== id) return;
    const key = botComputerControlKey()(bot);
    const holds = () => computerControl.ownsLease(key, controlLeaseId);
    return holds() ? holds : undefined;
  },
});
function closeSessionStreams(sessionId: string): void {
  browserLive.closeForOwner(sessionId);
  desktopViewer.closeForOwner(sessionId);
  for (const client of sseClients) {
    if (client.sessionId !== sessionId) continue;
    sseClients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
  }
}
/** Every frame is numbered, and the last few hundred are kept, so a client
 * whose connection dropped can ask for what it missed instead of
 * re-downloading every transcript. The desktop reconnects in milliseconds
 * and barely needs this; a phone reconnects every time it unlocks.
 *
 * The stream id makes the cursor safe across restarts: sequence numbers
 * begin again at 1 on boot, so a cursor from a previous run must be
 * rejected rather than used to replay a different run's frames. It rides
 * inside the SSE `id:` field, which means a browser EventSource resumes
 * correctly through its own Last-Event-ID with no client code at all. */
const STREAM_ID = randomUUID().slice(0, 8);
const REPLAY_MAX = 500;
const configuredSseHeartbeatMs = Number(process.env.COLONIE_SSE_HEARTBEAT_MS);
const SSE_HEARTBEAT_MS =
  Number.isFinite(configuredSseHeartbeatMs) && configuredSseHeartbeatMs > 0
    ? configuredSseHeartbeatMs
    : 15_000;
const replayBuffer: Array<{ seq: number; kind: string; frame: string | null; clientFrame: string | null; payload: Record<string, unknown> | null }> = [];

/** Screen frames are the only kind a client can decline. */
const wants = (client: SseClient, kind: string) => kind !== "screen" || client.screens;

/** `<streamId>:<seq>` — opaque to clients, and the only thing they need to
 * remember to resume. Returns null when it belongs to another run. */
function cursorSeq(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const [stream, seq] = value.split(":");
  if (stream !== STREAM_ID) return null;
  const parsed = Number(seq);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** `adminOnly` frames (a workspace spend notice) reach admin streams and
 * are withheld from client sessions, live and on replay. */
function broadcast(payload: Record<string, unknown>, options: { adminOnly?: boolean } = {}) {
  // Membership may also change through fleet/CLI config writes. Close stale
  // email streams before any further workspace data is delivered.
  sessions.revalidateEmailSessions();
  const seq = lastSeq() + 1;
  setLastSeq(seq);
  const kind = String(payload.kind ?? "");
  const frame = `id: ${STREAM_ID}:${seq}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`;
  // Store both projections as immutable frames: live and reconnecting clients
  // must receive the same filtered config without changing the admin event.
  const clientFrame = options.adminOnly
    ? null
    : kind === "config"
      ? `id: ${STREAM_ID}:${seq}\ndata: ${JSON.stringify({ ...configForAccess()(payload as ReturnType<typeof configStatus>, false), seq })}\n\n`
      : frame;
  // Live desktop captures can each be hundreds of kilobytes and become stale
  // as soon as the next one arrives. Keep their sequence slots so resume-gap
  // detection stays honest, but never retain their base64 payloads.
  replayBuffer.push({ seq, kind, frame: kind === "screen" ? null : frame, clientFrame: kind === "screen" ? null : clientFrame, payload: kind === "screen" ? null : payload });
  if (replayBuffer.length > REPLAY_MAX) replayBuffer.shift();
  for (const client of Array.from(sseClients)) {
    if (!wants(client, kind)) continue;
    // Admin-only frames (clientFrame null) never reach members, and a member never falls back to the admin frame.
    const out = client.admin ? frame : clientFrame === null ? null : memberFrame(client, seq, payload, clientFrame);
    if (out === null) continue;
    // Screen frames are replaceable and durable events are not: see
    // ./sse-fanout.ts for the backpressure/bound decision this makes.
    if (deliverSseFrame(client, kind, out) === "disconnected") {
      sseClients.delete(client);
    }
  }
}

/** The frame a non-admin stream gets: the shared client frame, unless a bot
 * is restricted and this member may not see all of what the frame carries —
 * then narrowed (bot-visibility.ts), withdrawn, or nothing at all (null). */
function memberFrame(client: SseClient, seq: number, payload: Record<string, unknown>, clientFrame: string | null): string | null {
  // A frame kept from clients altogether stays kept: never the admin copy.
  if (clientFrame === null) return null;
  if (client.viewer.kind === "all") return clientFrame;
  const visible = visibleTo(client.viewer);
  if (visible.everything) {
    noteSeen(payload, client.seen);
    return clientFrame;
  }
  const narrowed = frameForMember(payload, memberFrameContext(visible), client.seen);
  if (!narrowed) return null;
  return narrowed === payload ? clientFrame : `id: ${STREAM_ID}:${seq}\ndata: ${JSON.stringify({ ...narrowed, seq })}\n\n`;
}

  return {
    sseClients,
    audienceChanged,
    desktopViewer,
    closeSessionStreams,
    STREAM_ID,
    SSE_HEARTBEAT_MS,
    broadcast,
    wants,
    cursorSeq,
    memberFrame,
    replayBuffer,
  };
}
