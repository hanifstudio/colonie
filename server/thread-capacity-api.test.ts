// Per-bot thread capacity through the scripted ACP fixture: every turn is held
// at a FAKE_ACP_GATE_DIR gate (server/testing/fake-acp-gates.ts) until the
// test releases it, under the same disposable-home launcher used by the
// independent-threads API fixture. Each thread's turns run from its own task
// folder, so a gate's cwd names the thread it belongs to.
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-colonie.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { gateEvents, releaseAllGates, releaseGate, waitingGates, type FakeAcpGate } from "./testing/fake-acp-gates.ts";
import { openSse } from "./testing/sse.ts";

describe("per-bot thread capacity through an isolated HTTP fixture", () => {
  let fixture: VerificationServer | undefined;
  let gates: string;
  let evidence: unknown[];
  let poller: ReturnType<typeof setInterval> | undefined;
  // Every gate the test has seen, and the folders whose turns are "finished":
  // like the old per-thread gate file, a finished folder lets its current
  // and every later turn through.
  let seen: FakeAcpGate[];
  let finished: Set<string>;
  const projectDirs: string[] = [];

  const folderOf = (gate: FakeAcpGate) => basename(gate.cwd);
  const record = () => {
    for (const gate of waitingGates(gates)) {
      if (!seen.some((known) => known.key === gate.key)) seen.push(gate);
      if (finished.has(folderOf(gate))) releaseGate(gates, gate.key);
    }
  };
  const start = async (env: Record<string, string> = {}) => {
    evidence = [];
    seen = [];
    finished = new Set();
    fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, false, {
      fakeAcp: { env: { claude: { FAKE_ACP_UNIQUE_SESSION_IDS: "1", ...env } }, gates: true },
    });
    gates = fixture.info.gateDirs!.claude!;
    poller = setInterval(record, 20);
  };

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture!.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture!.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };
  const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as any[];
  /** The newest turn held for this thread folder, once the engine has it. */
  const held = async (folder: string, timeout = 15_000) => {
    let gate: FakeAcpGate | undefined;
    await expect.poll(() => {
      record();
      gate = seen.filter((candidate) => folderOf(candidate) === folder).at(-1);
      return Boolean(gate);
    }, { timeout }).toBe(true);
    return gate!;
  };
  /** Whether any turn for this folder ever reached the engine. */
  const launched = (folder: string) => {
    record();
    return seen.some((gate) => folderOf(gate) === folder);
  };
  const finish = (folder: string) => {
    finished.add(folder);
    record();
  };
  /** The turn is still held at its gate, in a live engine process. */
  const stillWorking = (gate: FakeAcpGate) => {
    expect(() => process.kill(gate.pid, 0)).not.toThrow();
    expect(gateEvents(gates).filter((event) => event.key === gate.key).map((event) => event.event)).toEqual(["waiting"]);
  };
  const busyThreads = async (botId: string) => (await botState(botId)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId) as string[];
  const send = (botId: string, threadId: string, text: string, sendId?: string) => api("POST", `/api/bots/${botId}/messages`, { threadId, text, sendId });
  const limit = async (maxConcurrentPerBot: number) => {
    const result = await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot } });
    expect(result.status).toBe(200);
    expect(result.body.threads).toEqual({ maxConcurrentPerBot });
    return result;
  };
  const botWithThreads = async (count: number) => {
    const created = await api("POST", "/api/bots", { name: "Capacity fixture" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const threads = [bot.threadId as string];
    for (let i = 1; i < count; i++) {
      const createdTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Capacity thread ${i + 1}` });
      expect(createdTask.status).toBe(201);
      threads.push(createdTask.body.task.threadId);
    }
    return { botId: bot.id as string, threads };
  };
  const pendingCard = async (threadId: string) =>
    (await messages(threadId)).find((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;

  afterEach(async () => {
    if (poller) clearInterval(poller);
    poller = undefined;
    if (!fixture) return;
    releaseAllGates(gates);
    const evidencePath = `${fixture.info.logPath}.capacity.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, gates: seen, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
    fixture = undefined;
    for (const project of projectDirs.splice(0)) await removeTempDir(project);
  });

  it("defaults to three, runs ten turns after raising the limit, and safely queues and cancels overflow", async () => {
    await start();
    expect((await api("GET", "/api/config")).body.threads).toEqual({ maxConcurrentPerBot: 3 });
    for (const maxConcurrentPerBot of [0, 11, 1.5, "2", null]) {
      expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot } })).status).toBe(400);
    }
    expect((await api("GET", "/api/config")).body.threads.maxConcurrentPerBot).toBe(3);
    const { botId, threads } = await botWithThreads(12);
    const firstThree = await Promise.all(threads.slice(0, 3).map((threadId, i) => send(botId, threadId, `ACTIVE_${i}`)));
    expect(firstThree.map((result) => result.status)).toEqual([202, 202, 202]);
    expect(firstThree.every((result) => !result.body.queued)).toBe(true);
    const initialTurns = await Promise.all(threads.slice(0, 3).map((threadId) => held(threadId)));
    expect(await busyThreads(botId)).toHaveLength(3);
    const fourth = await send(botId, threads[3], "FOURTH_AFTER_RAISE", "capacity_default_fourth");
    expect(fourth.status).toBe(202);
    expect(fourth.body).toMatchObject({ queued: true, reason: "capacity", threadId: threads[3] });
    expect((await messages(threads[3])).filter((message) => message.role === "user")).toEqual([]);
    expect(launched(threads[3])).toBe(false);

    await limit(10);
    await held(threads[3]);
    const rest = await Promise.all(threads.slice(4, 10).map((threadId, i) => send(botId, threadId, `ACTIVE_${i + 4}`)));
    expect(rest.every((result) => result.status === 202 && !result.body.queued)).toBe(true);
    const running = await Promise.all(threads.slice(0, 10).map((threadId) => held(threadId)));
    // Ten separate engine processes and sessions, one per thread folder.
    expect(new Set(running.map((gate) => gate.pid)).size).toBe(10);
    expect(new Set(running.map((gate) => gate.sessionId)).size).toBe(10);
    expect(new Set(running.map((gate) => gate.cwd)).size).toBe(10);
    expect(await busyThreads(botId)).toHaveLength(10);
    for (const turn of initialTurns) stillWorking(turn);
    expect(JSON.parse(readFileSync(join(fixture!.info.dataDir, "config.json"), "utf8")).threads).toEqual({ maxConcurrentPerBot: 10 });
    evidence.push({ simultaneousProviderProcesses: running.map((gate) => ({ pid: gate.pid, sessionId: gate.sessionId, cwd: gate.cwd })) });

    const overflow = await send(botId, threads[10], "ELEVENTH_WAITING", "capacity_eleventh_retry");
    expect(overflow.status).toBe(202);
    expect(overflow.body).toMatchObject({ queued: true, reason: "capacity", threadId: threads[10], queueId: expect.any(String) });
    expect((await send(botId, threads[10], "ELEVENTH_WAITING", "capacity_eleventh_retry")).body).toEqual(overflow.body);
    expect((await send(botId, threads[10], "CONFLICTING_RETRY", "capacity_eleventh_retry")).status).toBe(409);
    expect((await messages(threads[10])).filter((message) => message.role === "user")).toEqual([]);
    expect(launched(threads[10])).toBe(false);
    const cancelled = await send(botId, threads[11], "TWELFTH_CANCELLED", "capacity_twelfth_cancel");
    expect(cancelled.body).toMatchObject({ queued: true, reason: "capacity" });
    expect((await api("DELETE", `/api/bots/${botId}/queue/${cancelled.body.queueId}`, { threadId: threads[10] })).status).toBe(404);
    expect((await api("DELETE", `/api/bots/${botId}/queue/${cancelled.body.queueId}`, { threadId: threads[11] })).status).toBe(200);

    const other = await botWithThreads(1);
    expect((await send(other.botId, other.threads[0], "OTHER_BOT_INDEPENDENT")).body.queued).toBeUndefined();
    await held(other.threads[0]);
    expect(await busyThreads(other.botId)).toEqual(other.threads);
    expect(await busyThreads(botId)).toHaveLength(10);

    finish(threads[0]);
    expect((await held(threads[10])).text).toContain("ELEVENTH_WAITING");
    await expect.poll(() => busyThreads(botId)).toHaveLength(10);
    const drained = (await messages(threads[10])).filter((message) => message.role === "user");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ text: "ELEVENTH_WAITING", sendId: "capacity_eleventh_retry", queueId: overflow.body.queueId });
    expect((await messages(threads[11])).filter((message) => message.role === "user")).toEqual([]);
    expect(launched(threads[11])).toBe(false);
    for (const threadId of [...threads.slice(1, 11), ...other.threads]) finish(threadId);
    await expect.poll(() => busyThreads(botId), { timeout: 10_000 }).toEqual([]);
    await expect.poll(() => busyThreads(other.botId), { timeout: 10_000 }).toEqual([]);
    expect(launched(threads[11])).toBe(false);
  }, 60_000);

  it("dispatches routines into a free slot without waiting for whole-bot idle", async () => {
    await start();
    await limit(2);
    const { botId, threads } = await botWithThreads(2);
    expect((await send(botId, threads[0], "HOLD_ONE_SLOT")).body.queued).toBeUndefined();
    await held(threads[0]);
    expect(await busyThreads(botId)).toEqual([threads[0]]);
    const created = await api("POST", "/api/routines", {
      name: "Slot dispatch probe",
      prompt: "Write the scheduled digest.",
      target: "bot",
      botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) =>
      (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
    // One busy thread, one free slot: the run must start now instead of
    // waiting for the bot to become fully idle.
    const first = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
    await expect.poll(async () => (await runState(first.id))?.status, { timeout: 15_000 }).toBe("running");
    const firstRun = await runState(first.id);
    expect(firstRun.threadId).toBeTruthy();
    expect(firstRun.threadId).not.toBe(threads[0]);
    expect((await held(firstRun.threadId)).text).toContain("scheduled digest");
    expect(await busyThreads(botId)).toHaveLength(2);
    // Whole-bot idleness is no longer the gate: the bot flag stays busy
    // while the scheduled run occupies the second slot.
    expect((await botState(botId)).busy).toBe(true);
    // At capacity the next run defers until a slot frees.
    const second = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await runState(second.id))?.status).toBe("queued");
    finish(threads[0]);
    await expect.poll(async () => (await runState(second.id))?.status, { timeout: 15_000 }).toBe("running");
    const secondRun = await runState(second.id);
    expect(secondRun.threadId).not.toBe(firstRun.threadId);
    await held(secondRun.threadId);
    for (const threadId of await busyThreads(botId)) finish(threadId);
    await expect.poll(async () => (await busyThreads(botId)).length, { timeout: 15_000 }).toBe(0);
  }, 60_000);

  it("starts a routine in the bot's project folder while another thread works there", async () => {
    await start();
    await limit(2);
    const project = mkdtempSync(join(tmpdir(), "colonie-collide-"));
    projectDirs.push(project);
    // Both threads below pin to this one folder (startTurn's cwd resolution
    // for a bot with an explicit project folder), so their gates share one
    // folder: the newest held turn is whichever started last, and finishing
    // the folder lets both through.
    const key = basename(project);
    const { botId } = await botWithThreads(1);
    const threadId = (await botState(botId)).threadId as string;
    expect((await api("PATCH", `/api/bots/${botId}`, { cwd: project })).status).toBe(200);
    expect((await send(botId, threadId, "HOLD_THE_FOLDER")).body.queued).toBeUndefined();
    await expect.poll(() => busyThreads(botId)).toEqual([threadId]);
    expect((await held(key)).text).toContain("HOLD_THE_FOLDER");

    const created = await api("POST", "/api/routines", {
      name: "Workspace collision probe",
      prompt: "Write the scheduled digest.",
      target: "bot",
      botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) =>
      (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);

    // A free thread slot is all the run needs. The folder another thread
    // works in is no reason to hold it: a bot's threads work there side by
    // side, like several agent sessions open in one repo.
    const run = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("running");
    const dispatched = await runState(run.id);
    expect(dispatched.deferredAt).toBeUndefined();
    expect(dispatched.error).toBeUndefined();
    expect(dispatched.threadId).not.toBe(threadId);
    // …in that same folder, while the first thread is still working there.
    await expect.poll(async () => (await held(key)).text, { timeout: 15_000 }).toContain("scheduled digest");
    expect(realpathSync((await held(key)).cwd)).toBe(realpathSync(project));
    expect((await busyThreads(botId)).sort()).toEqual([threadId, dispatched.threadId].sort());

    finish(key);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    await expect.poll(async () => (await busyThreads(botId)).length, { timeout: 15_000 }).toBe(0);
  }, 60_000);

  it("dispatches delegated handoffs into the standing thread without waiting for whole-bot idle", async () => {
    // The woken delegator's reply echoes the whole prompt its engine received.
    await start({ FAKE_ACP_MODE: "echo-gated" });
    await limit(2);
    const target = await botWithThreads(2);
    const source = await botWithThreads(1);
    const created = await api("POST", "/api/routines", {
      name: "Delegated slot probe",
      prompt: "Hold the delegator turn.",
      target: "bot",
      botId: source.botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
    // The internal comms capability a held turn's engine was given: the
    // "agents" MCP entry of the session/new that opened in its folder.
    const sessionToken = async (threadId: string) => {
      let token: string | undefined;
      await expect.poll(() => {
        try {
          const params = JSON.parse(readFileSync(`${fixture!.fixtureDumpPath}.session.json`, "utf8"));
          if (basename(params.cwd) !== threadId) return false;
          const agents = (params.mcpServers ?? []).find((server: any) => server.name === "agents");
          token = agents?.env?.find((entry: any) => entry.name === "COLONIE_COMMS_TOKEN")?.value
            ?? agents?.headers?.find((entry: any) => entry.name.toLowerCase() === "authorization")?.value?.replace(/^Bearer /, "");
          return Boolean(token);
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }, { timeout: 15_000 }).toBe(true);
      return token!;
    };
    // A routine turn is today's classic delegate_bot caller — a plain chat
    // turn is steered to coordinate_bots — and its held turn supplies the
    // internal comms capability that caller holds.
    const delegatorTurn = async () => {
      const run = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("running");
      const started = await runState(run.id);
      await held(started.threadId);
      return { runId: run.id as string, threadId: started.threadId as string, token: await sessionToken(started.threadId) };
    };
    const delegate = async (turn: { threadId: string; token: string }) => {
      const response = await fetch(`${fixture!.info.url}/api/internal/delegate-bot`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${turn.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ toBotId: target.botId, message: "Delegated slot probe" }),
      });
      const result = { status: response.status, body: await response.json() as any };
      // The evidence records the authorization result, never the bearer.
      evidence.push({ authority: "existing provider capability", path: "/api/internal/delegate-bot", threadId: turn.threadId, result });
      return result;
    };
    // Read the woken reply from the conversation, not the run record: a run
    // keeps only the first 2,000 characters of its output, and the replayed
    // history ahead of the notice runs past that. The notice must be the
    // latest thing the delegator was told, after the teammate's reply.
    const expectWokenByCompletion = async (turn: { runId: string; threadId: string }) => {
      const replies = (await messages(turn.threadId)).filter((message) => message.role === "bot" && message.kind === "text");
      const reply = String(replies.at(-1)?.text ?? "");
      // the run recorded this same wake reply
      expect(reply.startsWith((await runState(turn.runId)).output)).toBe(true);
      const peerReply = reply.indexOf("@Capacity fixture replied to the delegated task");
      const notice = reply.lastIndexOf("[A delegated task just completed]");
      expect(peerReply).toBeGreaterThan(-1);
      expect(notice).toBeGreaterThan(peerReply);
      expect(reply.slice(notice)).toMatch(/^\[A delegated task just completed\]\n\nThe task you delegated to @Capacity fixture has finished, and their reply is now in this conversation\.\n\n[^]*Do not re-delegate the same task\.$/);
    };
    // One busy thread, one free slot: when the delegator's turn settles and
    // the handoff drains, it must land in the target's standing thread — its
    // newest task thread — instead of waiting for the whole bot to go idle.
    expect((await send(target.botId, target.threads[0], "HOLD_ONE_SLOT")).body.queued).toBeUndefined();
    await held(target.threads[0]);
    expect(await busyThreads(target.botId)).toEqual([target.threads[0]]);
    expect((await botState(target.botId)).busy).toBe(true);

    const first = await delegatorTurn();
    const queued = await delegate(first);
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ queued: true, taskId: expect.any(String) });
    finish(first.threadId);
    await held(target.threads[1]);
    // The busy list orders by recent activity, not thread creation.
    expect((await busyThreads(target.botId)).sort()).toEqual([...target.threads].sort());
    expect((await botState(target.botId)).busy).toBe(true);

    // Standing thread busy and capacity full: the next handoff holds with a
    // visible wait instead of dispatching.
    const second = await delegatorTurn();
    const waiting = await delegate(second);
    expect(waiting.body).toMatchObject({ queued: true, taskId: expect.any(String) });
    finish(second.threadId);
    await expect.poll(async () => (await runState(second.runId))?.status, { timeout: 15_000 }).toBe("waiting");
    expect((await messages(second.threadId)).some((message) => message.kind === "activity" && message.tool?.name?.includes("waiting — they're busy"))).toBe(true);
    expect((await busyThreads(target.botId)).sort()).toEqual([...target.threads].sort());

    // The standing thread frees while the other stays busy: the held handoff
    // re-tests its own admission and moves — the whole-bot busy flag is never
    // the gate. Its turn lands in the just-freed thread, whose folder is
    // already finished, so it settles and wakes the delegator.
    finish(target.threads[1]);
    await expect.poll(async () => (await runState(second.runId))?.status, { timeout: 20_000 }).toBe("completed");
    expect(await busyThreads(target.botId)).toEqual([target.threads[0]]);
    await expectWokenByCompletion(second);
    await expect.poll(async () => (await runState(first.runId))?.status, { timeout: 15_000 }).toBe("completed");
    await expectWokenByCompletion(first);
    finish(target.threads[0]);
    await expect.poll(async () => (await busyThreads(target.botId)).length + (await busyThreads(source.botId)).length, { timeout: 15_000 }).toBe(0);
  }, 90_000);

  it("restores cancellable queued receipts from a fresh snapshot and broadcasts complete queue changes", async () => {
    await start();
    await limit(1);
    const { botId, threads: [active, waiting, cancelled, deleted] } = await botWithThreads(4);
    expect((await send(botId, active, "ACTIVE_DURING_RELOAD")).body.queued).toBeUndefined();
    await held(active);
    const events = await openSse(`${fixture!.info.url}/api/events`);
    try {
      const queued = await send(botId, waiting, "RESTORE_AFTER_RELOAD", "reload_queue_receipt");
      expect(queued.body).toMatchObject({ queued: true, reason: "capacity", threadId: waiting });
      const receipt = { queueId: queued.body.queueId, text: "RESTORE_AFTER_RELOAD", reason: "capacity" };
      expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages).toEqual({ [waiting]: [receipt] });
      const enqueued = await events.until((frame) => frame.kind === "bot.queued" && frame.queues[waiting]?.[0]?.queueId === receipt.queueId);
      expect(enqueued.queues).toEqual({ [waiting]: [receipt] });
      const cancelReceipt = (await send(botId, cancelled, "CANCEL_AFTER_RELOAD")).body;
      const restored = (await api("GET", "/api/bots")).body.botQueuedMessages;
      expect(restored[cancelled]).toEqual([{ queueId: cancelReceipt.queueId, text: "CANCEL_AFTER_RELOAD", reason: "capacity" }]);
      expect((await api("DELETE", `/api/bots/${botId}/queue/${restored[cancelled][0].queueId}`, { threadId: waiting })).status).toBe(404);
      expect((await api("DELETE", `/api/bots/${botId}/queue/${restored[cancelled][0].queueId}`, { threadId: cancelled })).status).toBe(200);
      const removed = await events.until((frame) => frame.kind === "bot.queued" && frame.seq > enqueued.seq + 1 && !frame.queues[cancelled]);
      expect(removed.queues).toEqual({ [waiting]: [receipt] });
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({ [waiting]: [receipt] });

      await send(botId, deleted, "DELETE_QUEUED_TASK");
      const beforeDelete = await events.until((frame) => frame.kind === "bot.queued" && frame.queues[deleted]?.length);
      expect((await api("DELETE", `/api/bots/${botId}/tasks/${deleted}`)).status).toBe(200);
      expect((await events.until((frame) => frame.kind === "bot.queued" && frame.seq > beforeDelete.seq && !frame.queues[deleted])).queues).toEqual({ [waiting]: [receipt] });
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({ [waiting]: [receipt] });

      finish(active);
      expect((await held(waiting)).text).toContain(receipt.text);
      expect((await events.until((frame) => frame.kind === "bot.queued" && frame.seq > beforeDelete.seq && Object.keys(frame.queues).length === 0)).queues).toEqual({});
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({});
      expect((await messages(waiting)).filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({ text: receipt.text, queueId: receipt.queueId }),
      ]);
      expect((await messages(cancelled)).filter((message) => message.role === "user")).toEqual([]);
      expect(launched(cancelled)).toBe(false);
      expect(launched(deleted)).toBe(false);
      finish(waiting);
      await expect.poll(() => busyThreads(botId)).toEqual([]);
      evidence.push({ queueEvents: events.frames.filter((frame) => frame.kind === "bot.queued") });
    } finally { events.close(); }
  }, 30_000);

  it("counts approval waits, drains FIFO when raised or a turn finishes, and preserves active work when lowered", async () => {
    // Every turn asks for a tool approval once its gate opens. Only the first
    // thread asks the person; the others run with full access.
    await start({ FAKE_ACP_MODE: "permission" });
    await limit(1);
    const { botId, threads: [first, second, third, fourth] } = await botWithThreads(4);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${first}`, { approvalMode: "ask" })).status).toBe(200);
    for (const threadId of [second, third, fourth]) {
      expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { approvalMode: "full" })).status).toBe(200);
    }
    finish(first);
    expect((await send(botId, first, "APPROVAL_HOLDS_SLOT")).body.queued).toBeUndefined();
    const launchedFirst = await held(first);
    await expect.poll(() => pendingCard(first), { timeout: 15_000 }).toBeTruthy();
    const card = await pendingCard(first);
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.threadId === first).activity).toBe("waiting-on-you");
    expect(await busyThreads(botId)).toEqual([first]);
    const queued = [];
    for (const [index, threadId] of [second, third, fourth].entries()) {
      const result = await send(botId, threadId, `FIFO_${index + 1}`, `capacity_fifo_send_${index + 1}`);
      expect(result.body).toMatchObject({ queued: true, reason: "capacity" });
      queued.push(result.body.queueId);
      expect((await messages(threadId)).filter((message) => message.role === "user")).toEqual([]);
      expect(launched(threadId)).toBe(false);
    }

    await limit(2);
    const launchedSecond = await held(second);
    await expect.poll(() => busyThreads(botId)).toHaveLength(2);
    expect(() => process.kill(launchedFirst.pid, 0)).not.toThrow();
    expect((await botState(botId)).tasks.find((task: any) => task.threadId === first).activity).toBe("waiting-on-you");
    expect(launched(third)).toBe(false);
    expect(launched(fourth)).toBe(false);

    // Lowering the limit stops nothing that is already running.
    await limit(1);
    expect(await busyThreads(botId)).toHaveLength(2);
    expect(() => process.kill(launchedFirst.pid, 0)).not.toThrow();
    stillWorking(launchedSecond);
    expect(await pendingCard(first)).toMatchObject({ requestId: card.requestId });
    finish(second);
    await expect.poll(() => busyThreads(botId)).toEqual([first]);
    expect(launched(third)).toBe(false);
    expect((await messages(third)).filter((message) => message.role === "user")).toEqual([]);

    // Answering the card lets the first turn finish, which frees the slot.
    const response = await api("POST", `/api/bots/${botId}/respond`, { threadId: first, requestId: card.requestId, behavior: "allow" });
    expect(response.status).toBe(200);
    const launchedThird = await held(third);
    await expect.poll(() => busyThreads(botId)).toEqual([third]);
    expect(launched(fourth)).toBe(false);
    finish(third);
    const launchedFourth = await held(fourth);
    await expect.poll(() => busyThreads(botId)).toEqual([fourth]);
    expect(launchedSecond.at).toBeLessThan(launchedThird.at);
    expect(launchedThird.at).toBeLessThan(launchedFourth.at);
    finish(fourth);
    await expect.poll(() => busyThreads(botId)).toEqual([]);
    for (const [index, threadId] of [second, third, fourth].entries()) {
      const userMessages = (await messages(threadId)).filter((message) => message.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({ text: `FIFO_${index + 1}`, queueId: queued[index] });
    }
    evidence.push({ fifoThreadOrder: [second, third, fourth], lowerLimitPreservedActiveProcesses: [launchedFirst.pid, launchedSecond.pid], approvalUsedSlot: true });
  }, 45_000);
});
