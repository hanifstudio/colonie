// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BrowserSidePanel } from "./BrowserSidePanel";
import { resetComputerStore } from "@/lib/computer";
import { noteBotSurface, resetBotSurface } from "@/lib/bot-surface";
import type { ComputerView } from "../../shared/computer.ts";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api, useStore: () => ({ state: { selectedConversationId: undefined }, dispatch: vi.fn() }), currentTaskBot: (bot: unknown) => bot }));
vi.mock("@/lib/conversations", () => ({ useConversations: () => ({ conversations: [] }) }));
vi.mock("./DesktopCapabilities", () => ({ useCaptionChrome: () => ({ padClass: "" }) }));
vi.mock("./file-preview/use-preview-panel", () => ({ usePreviewPanel: () => ({ panel: { current: null }, width: 480, minimum: 320, maximum: 900, resize: {} }) }));
vi.mock("./routines/ConversationRoutines", () => ({ ConversationRoutines: () => null }));
vi.mock("./BotFilesPane", () => ({ BotFilesPane: () => createElement("div", { "data-testid": "files" }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => createElement("div", { "data-testid": "browser" }) }));
vi.mock("./ScreenPane", () => ({ ScreenPane: ({ onOpenBrowser }: { onOpenBrowser: () => void }) => createElement("div", { "data-testid": "screen" }, createElement("button", { onClick: onOpenBrowser }, "go browser")) }));

const view = (state: ComputerView["state"]): ComputerView => ({ state, message: null, screens: [], idleMinutes: 30 });
const bot = (extra: object = {}) => ({ id: "scout", name: "Scout", threadId: "t1", ...extra }) as never;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); resetComputerStore(); resetBotSurface(); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); resetComputerStore(); resetBotSurface(); host.remove(); vi.useRealTimers(); });
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("[aria-label='Bot panel view'] button")].find((entry) => entry.textContent?.trim() === name)!;
async function show(state: ComputerView, scout = bot()) {
  api.mockImplementation(async () => state);
  await act(async () => { root.render(createElement(BrowserSidePanel, { bot: scout })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

test("the panel has Screen, Browser and Files, and opens on the Screen", async () => {
  await show(view("off"));
  expect([...host.querySelectorAll("[aria-label='Bot panel view'] button")].map((entry) => entry.textContent?.trim())).toEqual(["Screen", "Browser", "Files"]);
  expect(host.querySelector("[data-testid=screen]")).not.toBeNull();
  await act(async () => { tab("Browser").click(); });
  expect(host.querySelector("[data-testid=browser]")).not.toBeNull();
  await act(async () => { tab("Files").click(); });
  expect(host.querySelector("[data-testid=files]")).not.toBeNull();
});

test("a server with no computer opens on the Browser, and the Screen tab is still there to explain itself", async () => {
  await show(view("unsupported"));
  expect(host.querySelector("[data-testid=browser]")).not.toBeNull();
  expect(tab("Screen")).toBeDefined();
  await act(async () => { tab("Screen").click(); });
  expect(host.querySelector("[data-testid=screen]")).not.toBeNull();
});

test("a link from the Screen tab goes to the Browser tab, and the choice is remembered for that bot", async () => {
  await show(view("off"));
  await act(async () => { [...host.querySelectorAll("button")].find((entry) => entry.textContent === "go browser")!.click(); });
  expect(host.querySelector("[data-testid=browser]")).not.toBeNull();
  expect(localStorage.getItem("colonie-bot-panel-view:scout")).toBe("browser");
});

test("a green dot marks the tab the bot is working in, only while it is busy", async () => {
  noteBotSurface("scout", "turn-1", "screen");
  await show(view("on"), bot({ busy: true }));
  expect(host.querySelector("[data-testid=working-screen]")).not.toBeNull();
  expect(host.querySelector("[data-testid=working-browser]")).toBeNull();
  await act(async () => { noteBotSurface("scout", "turn-2", "browser"); });
  expect(host.querySelector("[data-testid=working-browser]")).not.toBeNull();
  expect(host.querySelector("[data-testid=working-screen]")).toBeNull();
  await act(async () => { root.render(createElement(BrowserSidePanel, { bot: bot({ busy: false }) })); });
  expect(host.querySelector("[data-testid=working-browser]")).toBeNull();
});

test("with the computer on, the Browser tab says the bot browses on its Screen and offers it", async () => {
  await show(view("on"));
  await act(async () => { tab("Browser").click(); });
  expect(host.querySelector("[role=note]")?.textContent).toContain("The computer is on, so Scout browses on its Screen instead of here.");
  expect(host.querySelector("[data-testid=browser]")).not.toBeNull();
  await act(async () => { [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Open Screen")!.click(); });
  expect(host.querySelector("[data-testid=screen]")).not.toBeNull();
});

test("with the computer off the Browser tab is just the browser", async () => {
  await show(view("off"));
  await act(async () => { tab("Browser").click(); });
  expect(host.querySelector("[role=note]")).toBeNull();
});
