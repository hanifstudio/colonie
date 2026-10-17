import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
const fixtureAt = Date.UTC(2026, 8, 7, 12);
const avatarBots: Bot[] = ["Atlas", "Juniper"].map((name, i) => ({
  id: name.toLowerCase(), threadId: "thread-" + name.toLowerCase(), name,
  title: "Test bot", description: "",
  notifications: false, color: i ? "purple" : "green", unread: false,
  avatarUrl: "/api/attachments/fixture-" + i + ".png", avatarCrop: i ? "rounded" : "circle",
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
  tasks: [{ threadId: "thread-" + name.toLowerCase(), title: "Task", createdAt: fixtureAt,
    usage: { input: 100, output: 20, costUsd: 0.01, turns: 1 } }],
  messages: [],
}));

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: { ...actual.initialState, bots: avatarBots }, dispatch: vi.fn() }) };
});
// This file renders to a string with no DOM, so the module is replaced
// whole rather than spread over: its context default reads window.colonie at
// import time. An empty caption chrome is the non-Windows layout.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));
vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));
import { UsageSection } from "./UsageSection";
import { TeamMapPage } from "./TeamMapPage";
import { BotInstructionsDialog } from "./BotInstructionsDialog";
const render = (component: Parameters<typeof renderToStaticMarkup>[0]) => {
  vi.stubGlobal("window", { colonie: undefined });
  vi.stubGlobal("document", { body: {} });
  return renderToStaticMarkup(component);
};
afterEach(() => vi.unstubAllGlobals());
describe("uploaded bot identity portraits", () => {
  it.each([["usage", UsageSection], ["team map", TeamMapPage]] as const)("renders the uploaded portrait in %s", (_name, Component) => {
    expect(render(createElement(Component))).toContain('<img src="/api/attachments/fixture-0.png"');
  });
  it("renders the instructions portrait without losing dialog semantics", () => {
    const html = render(createElement(BotInstructionsDialog, { bot: avatarBots[0]!, onClose: vi.fn() }));
    expect(html).toContain('<img src="/api/attachments/fixture-0.png"');
    expect(html).toContain('role="dialog"');
  });
});
