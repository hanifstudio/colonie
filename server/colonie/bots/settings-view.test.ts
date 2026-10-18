// The settings-view factory is a thin gatherer over injected state, so the
// cases here pin the two decisions it actually makes: the ACP preview branch
// (only active sections, with byte and token totals taken from those) and
// botOverview's per-bot filtering of routines and history.
import { expect, test } from "vitest";
import { createBotSettingsView } from "./settings-view.ts";

const bot = (over: Record<string, unknown> = {}): any => ({
  id: "b1",
  name: "Nia",
  title: "",
  description: "",
  soul: "",
  chiefOfStaff: false,
  modelSelection: { instanceId: "inst" },
  ...over,
});

const view = (over: Record<string, unknown> = {}) => createBotSettingsView({
  approvalModeForTurn: () => () => "ask",
  cfg: () => ({}),
  engineMcpServers: () => () => ({}),
  listBotSkills: () => [],
  registry: { get: () => undefined },
  routines: () => ({ listRoutines: () => [], listRuns: () => [] }),
  store: { bots: [] },
  teamMemory: () => ({ systemPrompt: () => "" }),
  webhooks: () => ({ list: () => [] }),
  ...over,
});

const acpView = () => view({
  cfg: () => ({ instances: { inst: { driver: "claude-acp", config: { instructions: "Extra instance context." } } } }),
  registry: { get: (id: string) => (id === "inst" ? { driverKind: "claude-acp" } : undefined) },
});

test("the ACP preview keeps only active sections", () => {
  const preview: any = acpView().previewSystemPrompt(bot());
  expect(preview.sections.every((section: any) => section.status === "active")).toBe(true);
  expect(preview.sections.some((section: any) => section.id === "instance.instructions")).toBe(true);
  // The default app instructions are empty, so that section must not leak in.
  expect(preview.sections.some((section: any) => section.id === "app.instructions")).toBe(false);
});

test("the ACP preview totals are the active sections' bytes", () => {
  const preview: any = acpView().previewSystemPrompt(bot());
  const bytes = preview.sections.reduce((sum: number, section: any) => sum + section.bytes, 0);
  expect(preview.totalBytes).toBe(bytes);
  expect(preview.approxTokens).toBe(Math.ceil(bytes / 4));
});

test("the ACP preview says it is a developer preview", () => {
  const preview: any = acpView().previewSystemPrompt(bot());
  expect(String(preview.note)).toContain("Developer preview for a new conversation");
});

test("botOverview names this bot's routines and drops another bot's", async () => {
  const schedule = { type: "once", at: Date.UTC(2026, 0, 2, 12) };
  const routines = [
    { id: "r1", botId: "b1", name: "Morning digest", enabled: true, schedule, nextRunAt: null },
    { id: "r2", botId: "b2", name: "Other bot routine", enabled: true, schedule, nextRunAt: null },
  ];
  const overview: any = await view({ routines: () => ({ listRoutines: () => routines, listRuns: () => [] }) })
    .botOverview(bot());
  expect(overview.does.some((line: string) => line.includes("Morning digest"))).toBe(true);
  expect(overview.does.some((line: string) => line.includes("Other bot routine"))).toBe(false);
});

test("botOverview carries no history on a fresh data dir", async () => {
  const overview: any = await view().botOverview(bot());
  expect(overview.recent).toEqual([]);
  expect(overview.who.name).toBe("Nia");
});
