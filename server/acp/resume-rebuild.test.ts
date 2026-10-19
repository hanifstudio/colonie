// A conversation whose engine session is gone.
//
// The engine refusing a resumeCursor before it reads the prompt is a lost
// context, not a dead conversation: the turn runs once in one fresh session,
// carrying the transcript the harness rebuilt (server/resume-recovery.ts), and
// session.started says so. The fixture is a deterministic ACP agent speaking
// the real protocol over stdio (server/acp/testing/fake-agent.ts), and it
// refuses a session it does not have exactly as a real adapter does: the shape
// of an app restarted against a conversation saved somewhere the engine no
// longer reads.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { CodexAcpDriver } from "./codex-acp.ts";
import type { ProviderAdapter, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";

/** a session id no engine here ever created */
const MISSING = "01a152a2-0000-4000-8000-000000000000";

interface Fixture {
  stateFile: string;
  dir: string;
  adapter: ProviderAdapter;
  events: EventRecorder;
  /** what the fixture recorded as this session's prompts */
  prompts(sessionId: string): string[];
  turn(threadId: string, input: Partial<SendTurnInput> & { text: string }): Promise<{ turnId: string }>;
}

const running: Array<{ dir: string; adapter: ProviderAdapter; events: EventRecorder }> = [];
afterEach(async () => {
  for (const instance of running.splice(0)) {
    instance.events.stop();
    await instance.adapter.stopAll();
    await removeTempDir(instance.dir);
  }
});

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "colonie-acp-rebuild-"));
  const stateFile = join(dir, "fixture-state.json");
  const instance = await CodexAcpDriver.create({
    instanceId: "codex-acp",
    displayName: "Codex",
    enabled: true,
    environment: { COLONIE_FAKE_STATE: stateFile },
    config: CodexAcpDriver.decodeConfig({
      cli: process.execPath,
      args: ["--experimental-strip-types", join(import.meta.dirname, "testing", "fake-agent.ts")],
    }),
  });
  const events = recordEvents(instance.adapter);
  running.push({ dir, adapter: instance.adapter, events });
  return {
    dir, stateFile, adapter: instance.adapter, events,
    turn: (threadId, input) => instance.adapter.sendTurn({
      threadId, botId: "bot-1", cwd: dir, model: "agent-default", approvalMode: "ask", ...input,
    }),
    prompts(sessionId) {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { sessions: Record<string, { prompts: string[] }> };
      return state.sessions[sessionId]?.prompts ?? [];
    },
  };
}

/** Every turn on the same thread completes before the next one is sent. */
async function turn(f: Fixture, threadId: string, input: Partial<SendTurnInput> & { text: string }) {
  const before = f.events.events.length;
  const { turnId } = await f.turn(threadId, input);
  await f.events.until((event: RuntimeEvent) => event.type === "turn.completed" && event.turnId === turnId);
  return f.events.events.slice(before);
}

const sessionStarted = (events: RuntimeEvent[]) => events.find((event) => event.type === "session.started");
const notices = (events: RuntimeEvent[]) => events.filter((event) => event.type === "runtime.notice");

test("a session the engine no longer has is rebuilt from the turn's recovery text", async () => {
  const f = await fixture();
  // one conversation the engine does know, so the fixture's own bookkeeping is
  // not what is being tested
  await turn(f, "thread-known", { text: "the first message" });

  const seen = await turn(f, "thread-lost", { text: "the second message", resumeCursor: MISSING, recoveryText: "REBUILT TRANSCRIPT\n\nthe second message" });
  const started = sessionStarted(seen);
  expect(started).toMatchObject({ type: "session.started", rebuilt: true });
  const rebuilt = (started as { sessionId: string }).sessionId;
  expect(rebuilt).not.toBe(MISSING);
  // the person is told once, in the thread
  expect(notices(seen)).toHaveLength(1);
  // and the fresh session was handed the rebuilt conversation, not just the message
  expect(f.prompts(rebuilt).join("\n")).toContain("REBUILT TRANSCRIPT");

  // That session is live now, so the same stale cursor resumes like any other:
  // the transcript is not replayed a second time.
  const later = await turn(f, "thread-lost", { text: "the third message", resumeCursor: MISSING, recoveryText: "REBUILT TRANSCRIPT\n\nthe third message" });
  expect(notices(later)).toHaveLength(0);
  expect(f.prompts(rebuilt).at(-1)).not.toContain("REBUILT TRANSCRIPT");
  expect(f.prompts(rebuilt).at(-1)).toContain("the third message");
});

test("a rejected cursor with no rebuilt transcript still answers the message", async () => {
  const f = await fixture();
  const seen = await turn(f, "thread-lost", { text: "the second message", resumeCursor: MISSING });

  const started = sessionStarted(seen);
  expect(started).toMatchObject({ type: "session.started", rebuilt: true });
  expect(f.prompts((started as { sessionId: string }).sessionId).at(-1)).toContain("the second message");
});
