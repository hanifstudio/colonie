import {
  AlertCircleIcon,
  Clock03Icon,
  Loading02Icon,
  Notification01Icon,
} from "@hugeicons/core-free-icons";
import { describe, expect, it } from "vitest";
import type { Bot, Task } from "@/state/store";
import { botShowsUnread } from "@/lib/bot-unread";
import { t } from "@/lib/i18n";
import { attentionHasRunningWork, attentionJumpAction, attentionOwnerName, attentionRowStatus, attentionTriggerLabel, attentionUnpinAction, crossBotAttentionThreads, crossBotPinnedThreads } from "./SidebarBotActivity";

const task = (threadId: string, title: string, extra: Partial<Task>): Task =>
  ({ threadId, title, createdAt: 0, ...extra }) as Task;
const bot = (id: string, name: string, threadId: string, tasks?: Task[], extra: Partial<Bot> = {}): Bot =>
  ({ id, name, threadId, tasks, ...extra }) as unknown as Bot;

describe("botShowsUnread", () => {
  it("keeps the bot flag when there is no task list", () => {
    expect(botShowsUnread(bot("s", "Solo", "s0", undefined, { unread: true }))).toBe(true);
    expect(botShowsUnread(bot("s", "Solo", "s0", undefined))).toBe(false);
    expect(botShowsUnread(bot("s", "Solo", "s0", [], { unread: true }))).toBe(true);
  });

  it("ignores a hidden routine execution and counts a visible unread thread", () => {
    const hiddenOnly = bot("r", "Runner", "r0", [
      task("r0", "Read chat", {}),
      task("r1", "Failed run", { routineRunId: "run-1", unread: true }),
    ], { unread: true });
    expect(botShowsUnread(hiddenOnly)).toBe(false);
    const visible = bot("p", "Plain", "p0", [
      task("p0", "Unread chat", { unread: true }),
      task("p1", "Failed run", { routineRunId: "run-1", unread: true }),
    ]);
    expect(botShowsUnread(visible)).toBe(true);
  });
});

describe("header activity", () => {
  const entry = (task: Partial<Task> & { queued?: boolean }) => ({ kind: "bot" as const, botId: "a", botName: "Alpha", task: { threadId: "t", title: "T", createdAt: 0, queued: false, ...task } });

  it("names the pulse with the count only when there is something to count", () => {
    expect(attentionTriggerLabel(0)).toBe("Active Threads");
    expect(attentionTriggerLabel(2)).toBe(t("attention.titleCount", { count: 2 }));
  });

  it("marks running or queued work and leaves unread alone", () => {
    expect(attentionHasRunningWork([entry({ unread: true })])).toBe(false);
    expect(attentionHasRunningWork([entry({ activity: "waiting-on-you" })])).toBe(false);
    expect(attentionHasRunningWork([entry({ activity: "waiting-on-you", busy: true })])).toBe(false);
    expect(attentionHasRunningWork([entry({ activity: "waiting-on-you", busy: true, queued: true })])).toBe(true);
    expect(attentionHasRunningWork([entry({ activity: "working" })])).toBe(true);
    expect(attentionHasRunningWork([entry({ busy: true })])).toBe(true);
    expect(attentionHasRunningWork([entry({ queued: true })])).toBe(true);
  });
});

describe("cross-bot attention", () => {
  it("collects only attention threads from every other bot, waiting first across bots", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle chat", {}),
      task("a1", "Waiting approval", { activity: "waiting-on-you" }),
      task("a2", "Unread reply", { unread: true }),
    ]);
    const beta = bot("b", "Beta", "b0", [
      task("b0", "Building site", { busy: true, activity: "working" }),
      task("b1", "Wrapped long ago", {}),
    ]);
    const entries = crossBotAttentionThreads([alpha, beta], { b2: [{}] }, "current");
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["a1", "b0", "a2"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Alpha", "Beta", "Alpha"]);
  });

  it("excludes the bot the picker belongs to and keeps queued threads", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Waiting approval", { activity: "waiting-on-you" })]);
    const beta = bot("b", "Beta", "b0", [task("b0", "Queued job", {})]);
    const entries = crossBotAttentionThreads([alpha, beta], { b0: [{}] }, "a");
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["b0"]);
    expect(entries[0].task.queued).toBe(true);
  });

  it("falls back to the bot's own line when it has no task list yet", () => {
    const solo = bot("s", "Solo", "s0", undefined, { unread: true });
    expect(crossBotAttentionThreads([solo], {}).map((entry) => entry.task.threadId)).toEqual(["s0"]);
  });
  it("never offers a hidden bot or a routine run", () => {
    const hidden = bot("h", "Hidden", "h0", [task("h0", "Waiting", { activity: "waiting-on-you" })], { hidden: true });
    const runner = bot("r", "Runner", "r0", [task("r0", "Routine step", { routineRunId: "run-1", busy: true })]);
    const plain = bot("p", "Plain", "p0", [task("p0", "Unread note", { unread: true })]);
    expect(crossBotAttentionThreads([hidden, runner, plain], {}).map((entry) => entry.task.threadId)).toEqual(["p0"]);
  });

  it("orders waiting ahead of unread across bots, not just inside one", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const beta = bot("b", "Beta", "b0", [task("b0", "Waiting approval", { activity: "waiting-on-you" })]);
    expect(crossBotAttentionThreads([alpha, beta], {}).map((entry) => entry.task.threadId)).toEqual(["b0", "a0"]);
  });

  it("jumps a bot entry with switchTask", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const [entry] = crossBotAttentionThreads([alpha], {});
    expect(attentionJumpAction(entry)).toEqual({ type: "switchTask", botId: "a", threadId: "a0" });
  });
});

describe("cross-bot pinned threads", () => {
  it("collects only pinned threads from every bot, newest pin first", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle chat", {}),
      task("a1", "Old pin", { pinned: true, updatedAt: 1 }),
    ]);
    const beta = bot("b", "Beta", "b0", [
      task("b0", "Unpinned", {}),
      task("b1", "New pin", { pinned: true, updatedAt: 2 }),
    ]);
    const entries = crossBotPinnedThreads([alpha, beta], {});
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["b1", "a1"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Beta", "Alpha"]);
  });

  it("ignores a pinned routine run and a hidden bot", () => {
    const visible = bot("v", "Visible", "v0", [task("v0", "Pinned run", { pinned: true, routineRunId: "run-1" })]);
    const hidden = bot("h", "Hidden", "h0", [task("h0", "Pinned elsewhere", { pinned: true })], { hidden: true });
    expect(crossBotPinnedThreads([visible, hidden], {})).toEqual([]);
  });

  it("marks a pinned thread queued the same way attention does", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true })]);
    const [entry] = crossBotPinnedThreads([alpha], { a0: [{}] });
    expect(entry.task.queued).toBe(true);
  });

  it("keeps pinned task status independent of the bot's aggregate activity", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle pin", { pinned: true, busy: false, activity: "idle" }),
      task("a1", "Working pin", { pinned: true, busy: true, activity: "working" }),
    ], { busy: true, activity: "waiting-on-you" });
    const entries = crossBotPinnedThreads([alpha], {});
    expect(attentionRowStatus(entries[0].task).active).toBe(false);
    expect(attentionRowStatus(entries[1].task).label).toBe(t("chat.activity.working"));
  });
});

describe("attentionRowStatus", () => {
  it("flags a waiting-on-you task active with the CircleAlert icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, activity: "waiting-on-you" });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.waiting"));
    expect(status.icon).toBe(AlertCircleIcon);
  });

  it("flags a working task active with the spinning Loader2 icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, busy: true, activity: "working" });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("chat.activity.working"));
    expect(status.icon).toBe(Loading02Icon);
  });

  it("flags a queued task active with the Clock3 icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: true });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.queued"));
    expect(status.icon).toBe(Clock03Icon);
  });

  it("flags an unread task active with the BellDot icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, unread: true });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.unread"));
    expect(status.icon).toBe(Notification01Icon);
  });

  it("marks a plain idle task inactive", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false });
    expect(status.active).toBe(false);
  });
});

describe("attentionUnpinAction", () => {
  it("unpins a bot thread via updateTask", () => {
    const [entry] = crossBotPinnedThreads([bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true })])], {});
    expect(attentionUnpinAction(entry)).toEqual({ type: "updateTask", botId: "a", threadId: "a0", patch: { pinned: false } });
  });
});
