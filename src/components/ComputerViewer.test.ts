// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComputerViewer } from "./ComputerViewer";

const { api, made } = vi.hoisted(() => ({ api: vi.fn(), made: [] as Array<{ url: string; viewOnly: boolean; disconnected: boolean; fire: (name: string) => void }> }));
vi.mock("@/state/store", () => ({ api }));
vi.mock("@novnc/novnc", () => ({
  default: class {
    viewOnly = false; scaleViewport = false; background = ""; disconnected = false; url: string;
    handlers = new Map<string, () => void>();
    constructor(_target: unknown, url: string) { this.url = url; made.push(this as never); }
    addEventListener(name: string, handler: () => void) { this.handlers.set(name, handler); }
    fire(name: string) { this.handlers.get(name)?.(); }
    disconnect() { this.disconnected = true; }
  },
}));

const bot = { id: "scout", name: "Scout" } as never;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); made.length = 0; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);
const render = async () => { await act(async () => { root.render(createElement(ComputerViewer, { bot })); }); await act(async () => { await Promise.resolve(); }); };

test("it opens the bot's screen, connects watch-only, and only a person's Take over lets them type", async () => {
  api.mockResolvedValue({ ok: true });
  await render();
  expect(api).toHaveBeenCalledWith("/api/computer/screens/scout", expect.objectContaining({ method: "POST" }));
  expect(made).toHaveLength(1);
  expect(made[0]!.url).toMatch(/^ws:\/\/.+\/api\/computer\/screens\/scout\/websockify$/);
  expect(made[0]!.viewOnly).toBe(true);
  expect(host.textContent).toContain("Connecting");
  expect(button("Take over")!.disabled).toBe(true);

  await act(async () => { made[0]!.fire("connect"); });
  expect(host.textContent).toContain("Watching Scout's screen");
  await act(async () => { button("Take over")!.click(); });
  expect(made[0]!.viewOnly).toBe(false);
  expect(host.textContent).toContain("You're in control");
  await act(async () => { button("Hand back")!.click(); });
  expect(made[0]!.viewOnly).toBe(true);
});

test("a screen that cannot be opened says why and Try again asks once more", async () => {
  api.mockRejectedValueOnce(new Error("All 4 screens are in use. Turn one bot's computer work off, or try again in a moment."));
  await render();
  expect(made).toHaveLength(0);
  expect(host.querySelector("[role=status]")?.textContent).toContain("All 4 screens are in use");
  api.mockResolvedValue({ ok: true });
  await act(async () => { button("Try again")!.click(); });
  await act(async () => { await Promise.resolve(); });
  expect(made).toHaveLength(1);
});

test("a dropped connection is shown, and leaving closes the connection", async () => {
  api.mockResolvedValue({ ok: true });
  await render();
  await act(async () => { made[0]!.fire("connect"); });
  await act(async () => { made[0]!.fire("disconnect"); });
  expect(host.querySelector("[role=status]")?.textContent).toContain("The screen disconnected");
  await act(async () => { button("Try again")!.click(); });
  await act(async () => { await Promise.resolve(); });
  expect(made).toHaveLength(2);
  expect(made[0]!.disconnected).toBe(true);
  await act(async () => { root.unmount(); });
  expect(made[1]!.disconnected).toBe(true);
  root = createRoot(host);
});
