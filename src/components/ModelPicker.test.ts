// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import { ProviderMark } from "./ProviderIcons";

const { state } = vi.hoisted(() => ({ state: { instances: [] as unknown[], bots: [] as unknown[] } }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state, dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() }),
  currentTaskBot: (bot: unknown) => bot,
}));

const instance = {
  instanceId: "codex",
  displayName: "Codex",
  driverKind: "codex-acp",
  snapshot: { authenticated: true },
  models: { options: [{ id: "default", label: "Codex default" }] },
};
const bot = { id: "bot", name: "Rio", threadId: "t1", busy: false, modelSelection: { instanceId: "codex", model: "default" } };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  state.instances = [instance];
  state.bots = [bot];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); });

test("the header chip names the model in text, and its label and tooltip carry the full text", async () => {
  await act(() => root.render(createElement(ModelPicker, { bot: bot as never, threadId: "t1" })));
  const chip = host.querySelector<HTMLButtonElement>('[data-tour="model"]')!;
  expect(chip.textContent).toContain("Codex default");
  expect(chip.getAttribute("aria-label")).toBe("Choose model: Codex · Codex default");
  expect(chip.getAttribute("title")).toContain("Codex · Codex default");
});

test("a Codex or Claude engine shows its own mark, never a bare letter that fills the chip", () => {
  for (const driverKind of ["codex-acp", "claude-acp"]) {
    const html = host.appendChild(document.createElement("div"));
    html.innerHTML = "";
    const mark = document.createElement("div");
    host.append(mark);
    const r = createRoot(mark);
    act(() => r.render(createElement(ProviderMark, { driverKind, size: 14 })));
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.textContent).toBe("");
    act(() => r.unmount());
  }
  const unknown = document.createElement("div");
  host.append(unknown);
  const r = createRoot(unknown);
  act(() => r.render(createElement(ProviderMark, { driverKind: "mystery", size: 14 })));
  expect(unknown.querySelector("span")!.getAttribute("style")).toContain("width: 14px");
  act(() => r.unmount());
});

// ChatView is too large to render in a unit test, so the bot panel toggle is checked in its source: the
// button is named for what it opens (the screen, browser and files), and shows a monitor, not a globe.
test("the bot panel toggle in the chat header is named for the whole panel and shows a monitor", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/components/ChatView.tsx", "utf8");
  const toggle = source.slice(source.indexOf('data-tour="computer"'), source.indexOf("</button>", source.indexOf('data-tour="computer"')));
  expect(toggle).toContain("chat.openBotPanel");
  expect(toggle).toContain("chat.closeBotPanel");
  expect(toggle).toContain("MonitorIcon");
  expect(toggle).not.toContain("GlobeIcon");
  const en = JSON.parse(readFileSync("src/locales/en.json", "utf8"));
  expect(en["chat.openBotPanel"]).toBe("Open the bot's screen, browser and files");
  expect(en["chat.closeBotPanel"]).toBe("Close the bot's screen, browser and files");
});
