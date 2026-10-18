// The per-thread state a finished turn's digest reads: when the turn started, the pre-turn workspace checkpoint, the thread's live turn id, and the recorder that turns those plus observed tools and memory into the stored digest row. index.ts keeps the maps in this module and destructures the names its dispatch, bus and resume wiring still read.
import * as checkpoints from "../../colonie/chat/checkpoints.ts";
import { type Message } from "../../persistence/store.ts";
import { recordHanded } from "../../colonie/chat/delta-context.ts";
import { buildTurnDigest, coverageForDriver, renderDigest, toolEvidence } from "../../colonie/chat/digest.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface TurnDigestDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createTurnDigest(deps: TurnDigestDeps) {
  const {
    isContextMessage, memoryRowsByThread, store
  } = deps;


// Per-thread state the digest needs from before the turn: when it started,
// and the checkpoint taken at dispatch (hash + folder) so settle can diff.
// `pin` is the dispatch that pinned that commit in the shadow repo, so a
// sibling thread's snapshot in the same folder cannot reclaim it mid-turn.
const turnStartedAt = new Map<string, number>();
const turnCheckpoints = new Map<string, { botId: string; cwd: string; hash: string; pin: string }>();
// The turn a thread is in, from the last event that named one. Not every
// driver stamps every item with a turnId (ACP fakes, some ACP agents), and
// a digest can only count activity it can attribute — so an unstamped tool
// row is attributed to the thread's live turn instead of to nothing.
const liveTurnByThread = new Map<string, string>();

/** Forget a thread's pre-turn checkpoint and drop its pin, so the shadow
 * repo's next cleanup may reclaim that commit. */
function forgetTurnCheckpoint(threadId: string): void {
  const checkpoint = turnCheckpoints.get(threadId);
  if (!checkpoint) return;
  turnCheckpoints.delete(threadId);
  void checkpoints.release(checkpoint.botId, checkpoint.cwd, checkpoint.pin);
}

function clearTurnDigestState(threadId: string): void {
  turnStartedAt.delete(threadId);
  forgetTurnCheckpoint(threadId);
  liveTurnByThread.delete(threadId);
  memoryRowsByThread.delete(threadId);
}

/** Persist observed tools and memory immediately, then enrich that same
 * row only if its task and active branch still exist. */
async function scheduleTurnDigest(input: {
  botId: string;
  botName: string;
  threadId: string;
  turnId: string;
  driverKind: string | undefined;
  instanceId?: string;
  reply: string;
  from?: Message["from"];
  isCurrent: () => boolean;
  usage?: { input: number; output: number; cachedInput?: number; costUsd?: number | null };
  succeeded?: boolean;
}): Promise<void> {
  const at = Date.now();
  const startedAt = turnStartedAt.get(input.threadId);
  turnStartedAt.delete(input.threadId);
  const checkpoint = turnCheckpoints.get(input.threadId);
  turnCheckpoints.delete(input.threadId);
  const memory = memoryRowsByThread.get(input.threadId) ?? [];
  memoryRowsByThread.delete(input.threadId);
  try {
    if (!input.isCurrent()) return;
    const activities = store.activePath(input.threadId);
    const digest = buildTurnDigest({
      turnId: input.turnId,
      botId: input.botId,
      threadId: input.threadId,
      at,
      durationMs: startedAt ? Math.max(0, at - startedAt) : 0,
      activities,
      memory,
      reply: input.reply,
      ...(input.usage ? { usage: input.usage } : {}),
      hookCoverage: coverageForDriver(input.driverKind, toolEvidence(activities, input.turnId), activities.some((m: any) => m.kind === "activity" && m.turnId === input.turnId && m.tool?.itemId)),
    });
    const message = store.appendMessage(input.threadId, {
        role: "bot",
        kind: "digest",
        text: renderDigest(digest),
        digest,
        turnId: input.turnId,
        requestMessageId: activities.find((message: any) => message.turnId === input.turnId && message.requestMessageId)?.requestMessageId,
        turnSucceeded: input.succeeded,
        ...(input.from ? { from: input.from } : {}),
      }, { kind: "digest.append", key: `${input.threadId}:${input.turnId}` });
    // This is derived from the native session's own work, not an unseen
    // teammate message. Record it alongside that turn's replies so normal
    // resumes stay delta-only. Other engines still receive it on replay.
    if (input.instanceId && !input.from) {
      const handed = store.taskByThread(input.botId, input.threadId)?.handedMessages?.[input.instanceId];
      if (handed) store.setHandedMessages(input.botId, input.threadId, input.instanceId,
        recordHanded(handed, store.activePath(input.threadId).filter(isContextMessage()).map((row: any) => row.id), [message.id]));
    }
    if (!checkpoint) return;
    // A folder-level diff: when a sibling thread of this bot works in the
    // same folder, its edits since this turn's snapshot are listed here too.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const capture = async () => {
      return checkpoints.diffWorkingTree(input.botId, checkpoint.cwd, checkpoint.hash, controller.signal);
    };
    let files: Awaited<ReturnType<typeof capture>>;
    try {
      files = await Promise.race([
        capture(),
        new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 3_000); }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
    if (!files || !input.isCurrent() || !store.activePath(input.threadId).some((row: any) => row.id === message.id)) return;
    const withFiles = buildTurnDigest({ ...digest, activities, memory, files });
    store.patchMessage(input.threadId, message.id, { digest: withFiles, text: renderDigest(withFiles) }, { kind: "digest.files", key: `${input.threadId}:${input.turnId}` });
  } catch (error) {
    console.error(`digest: could not record turn ${input.turnId} on ${input.threadId}:`, error instanceof Error ? error.message : error);
  } finally {
    // The pre-turn commit has had its last reader (the diff above is queued
    // ahead of this in the shadow repo); the next snapshot may reclaim it.
    if (checkpoint) void checkpoints.release(checkpoint.botId, checkpoint.cwd, checkpoint.pin);
  }
}


  return {
    turnStartedAt,
    turnCheckpoints,
    liveTurnByThread,
    clearTurnDigestState,
    forgetTurnCheckpoint,
    scheduleTurnDigest,
  };
}
