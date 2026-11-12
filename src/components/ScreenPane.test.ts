// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ScreenPane } from "./ScreenPane";
import { resetComputerStore } from "@/lib/computer";
import type { ComputerView } from "../../shared/computer.ts";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
vi.mock("./ComputerViewer", () => ({
  ComputerViewer: ({ bot, taken, onTakeOver, onHandBack }: { bot: { name: string }; taken: boolean; onTakeOver: () => void; onHandBack: () => void }) =>
    createElement("div", { "data-testid": "viewer" }, `screen of ${bot.name} ${taken ? "taken" : "watched"}`,
      createElement("button", { onClick: onTakeOver }, "mock take"), createElement("button", { onClick: onHandBack }, "mock back")),
}));

const bot = { id: "scout", name: "Scout" } as never;
const view = (state: ComputerView["state"], extra: Partial<ComputerView> = {}): ComputerView => ({ state, message: null, screens: [], idleMinutes: 30, ...extra });
let root: Root;
let host: HTMLDivElement;
const openBrowser = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); resetComputerStore();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); resetComputerStore(); host.remove(); vi.useRealTimers(); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);
/** Start again with nothing remembered, as a new panel would. */
async function fresh() {
  await act(() => root.unmount());
  resetComputerStore();
  host.remove();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
}
async function show(state: ComputerView) {
  api.mockImplementation(async (path: string) => { if (path === "/api/computer") return state; throw new Error(`unexpected ${path}`); });
  await act(async () => { root.render(createElement(ScreenPane, { bot, onOpenBrowser: openBrowser })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

test("where the server cannot run a computer, the Screen says so and points to the Browser tab", async () => {
  await show(view("unsupported"));
  expect(host.textContent).toContain("A screen isn't available here yet");
  expect(host.textContent).toContain("Scout browses in the Browser tab");
  await act(async () => { button("Open Browser")!.click(); });
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(button("Turn on computer")).toBeUndefined();
});

test("with the computer off the Screen offers it with its cost said plainly, and never shows a browser", async () => {
  await show(view("off"));
  expect(host.textContent).toContain("Give Scout a computer");
  expect(host.textContent).toContain("1 GB");
  expect(host.textContent).toContain("30 idle minutes");
  expect(host.querySelector("[data-testid=browser]")).toBeNull();
  await act(async () => { button("Until then, Scout browses in the Browser tab")!.click(); });
  expect(openBrowser).toHaveBeenCalledOnce();
  api.mockImplementation(async (path: string, init?: { method?: string }) => path === "/api/computer/on" && init?.method === "POST" ? view("preparing") : view("off"));
  await act(async () => { button("Turn on computer")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/computer/on", { method: "POST" });
  expect(host.textContent).toContain("The first time takes a few minutes");
  expect(button("Turn on computer")).toBeUndefined();
});

test("while it starts the person sees that, and without Docker or Podman is told what to install", async () => {
  await show(view("starting"));
  expect(host.textContent).toContain("Starting the computer");
  await fresh();
  await show(view("no-runtime", { message: "Colonie needs Docker or Podman to run a computer. Install one, then check again." }));
  expect(host.textContent).toContain("Docker or Podman");
  expect(button("Check again")).toBeDefined();
  expect(button("Turn on computer")).toBeUndefined();
});

test("a failed start says why, and is not shown when the computer is simply off", async () => {
  await show(view("off"));
  expect(host.querySelector("[role=alert]")).toBeNull();
  await fresh();
  await show(view("off", { message: "The computer did not become ready: timeout" }));
  expect(host.querySelector("[role=alert]")?.textContent).toContain("did not become ready");
});

test("with the computer on the Screen is the bot's screen, and Turn off puts it away", async () => {
  await show(view("on", { screens: [{ botId: "scout", taken: false }, { botId: "reka", taken: false }] }));
  expect(host.querySelector("[data-testid=viewer]")?.textContent).toContain("screen of Scout watched");
  expect(host.textContent).toContain("2 bots have a screen");
  api.mockImplementation(async () => view("off"));
  await act(async () => { button("Turn off")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/computer/off", { method: "POST" });
  expect(host.textContent).toContain("Give Scout a computer");
});

test("Take over and Hand back go to this bot's screen, and the viewer shows what the server says", async () => {
  await show(view("on", { screens: [{ botId: "scout", taken: false }, { botId: "reka", taken: true }] }));
  expect(host.querySelector("[data-testid=viewer]")?.textContent).toContain("watched");
  api.mockImplementation(async () => view("on", { screens: [{ botId: "scout", taken: true }, { botId: "reka", taken: true }] }));
  await act(async () => { button("mock take")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/computer/screens/scout/take", { method: "POST" });
  expect(host.querySelector("[data-testid=viewer]")?.textContent).toContain("taken");
  api.mockImplementation(async () => view("on", { screens: [{ botId: "scout", taken: false }, { botId: "reka", taken: true }] }));
  await act(async () => { button("mock back")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/computer/screens/scout/hand-back", { method: "POST" });
  expect(host.querySelector("[data-testid=viewer]")?.textContent).toContain("watched");
});
