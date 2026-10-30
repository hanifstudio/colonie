// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConversationRoutines, RoutineConversationList, routinesInConversation } from "./ConversationRoutines";
import { getDraft, setDraft } from "@/lib/drafts";
import type { Routine, RoutineRun } from "@/lib/routines";

let root: Root;
let host: HTMLDivElement;
const { state, dispatch, api } = vi.hoisted(() => ({ state: { routines: [] as Routine[], routineRuns: [] as RoutineRun[], bots: [{ id: "ada", name: "Ada" }], routinesLoadState: "ready" }, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state, dispatch }), api }));
const routine = (patch: Partial<Routine> = {}): Routine => ({
  id: "report", name: "Weekly launch report", prompt: "Read the checklist and summarize changes.", target: "bot", botId: "ada",
  runOn: "maus", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30,
  nextRunAt: Date.now() + 86_400_000, createdAt: 1, updatedAt: 1, conversation: { id: "launch", threadId: "launch-chat" }, ...patch,
});
const run = (patch: Partial<RoutineRun> = {}): RoutineRun => ({
  id: "run", routineId: "report", routineName: "Weekly launch report", target: "bot", botId: "ada", runOn: "maus",
  scheduledFor: Date.now(), status: "running", manual: true, createdAt: Date.now(), ...patch,
});
beforeEach(() => { vi.clearAllMocks(); state.routines = []; state.routineRuns = []; state.routinesLoadState = "ready"; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); });

test("the conversation list excludes another DM even when it uses the same bot", () => {
  const group = routine(); const dm = routine({ id: "private", conversation: { threadId: "dm-chat" } });
  expect(routinesInConversation([group, dm], "launch-chat")).toEqual([group]);
  expect(routinesInConversation([group, dm], "dm-chat")).toEqual([dm]);
  expect(routinesInConversation([routine({ conversation: undefined, sourceThreadId: "older-chat" })], "older-chat")).toHaveLength(1);
});

test("an empty conversation explains how to ask for scheduled work", async () => {
  await act(() => root.render(createElement(RoutineConversationList, { routines: [], runs: [], bots: [], pending: null, onAction: () => {}, onEdit: () => {} })));
  expect(host.textContent).toContain("Every weekday at 9 AM");
  expect(host.textContent).not.toContain("cron");
});

test("the list names the bot, schedule and next run; controls act on that exact routine", async () => {
  const onAction = vi.fn(); const onEdit = vi.fn(); const current = routine();
  await act(() => root.render(createElement(RoutineConversationList, { routines: [current], runs: [], bots: [{ id: "ada", name: "Ada" }], pending: null, onAction, onEdit })));
  expect(host.textContent).toContain("Ada"); expect(host.textContent).toContain("Next"); expect(host.textContent).toContain("Mon");
  const click = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!.click();
  await act(() => { click("Pause"); click("Run now"); click("Delete"); click("Edit in chat"); });
  expect(onAction.mock.calls).toEqual([[current, "pause"], [current, "run"], [current, "delete"]]);
  expect(onEdit).toHaveBeenCalledWith(current);
});

test("active work cannot be started twice, can be stopped, and says what it waits for", async () => {
  const onAction = vi.fn(); const current = routine();
  await act(() => root.render(createElement(RoutineConversationList, { routines: [current], runs: [run({ status: "waiting", attention: "Waiting for Ana to approve" })], bots: [], pending: null, onAction, onEdit: () => {} })));
  expect(host.textContent).toContain("Waiting for Ana to approve");
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.find((button) => button.textContent === "Run now")?.disabled).toBe(true);
  await act(() => buttons.find((button) => button.textContent === "Stop run")!.click());
  expect(onAction).toHaveBeenCalledWith(current, "stop");
});

test("paused schedules can resume; finished one-time schedules offer no misleading resume", async () => {
  const onAction = vi.fn();
  await act(() => root.render(createElement(RoutineConversationList, { routines: [routine({ enabled: false })], runs: [], bots: [], pending: null, onAction, onEdit: () => {} })));
  expect(host.textContent).toContain("Resume");
  await act(() => root.render(createElement(RoutineConversationList, { routines: [routine({ enabled: false, nextRunAt: null, schedule: { type: "once", at: 1 } })], runs: [], bots: [], pending: null, onAction, onEdit: () => {} })));
  expect(host.textContent).not.toContain("Resume");
  expect(host.textContent).toContain("Run now");
});

test("the header opens a keyboard-accessible dialog and editing preserves the existing draft", async () => {
  state.routines = [routine()];
  setDraft(window.localStorage, "conversation:launch", "My existing message");
  await act(() => root.render(createElement(ConversationRoutines, { threadId: "launch-chat", conversationId: "launch" })));
  const trigger = host.querySelector<HTMLButtonElement>("button")!; trigger.focus();
  await act(() => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  await act(() => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit in chat")!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(getDraft(window.localStorage, "conversation:launch")).toBe('My existing message\n\n@Ada Change the routine "Weekly launch report": ');
  expect(document.activeElement).toBe(trigger);
});

test("a rejected control shows its error and lets the person retry", async () => {
  state.routines = [routine()]; api.mockRejectedValueOnce(new Error("The workspace is offline."));
  await act(() => root.render(createElement(ConversationRoutines, { threadId: "launch-chat", conversationId: "launch" })));
  await act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  const pause = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Pause")!;
  await act(() => pause.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("The workspace is offline.");
  expect(pause.disabled).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});
