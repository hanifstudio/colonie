// @vitest-environment happy-dom
// The bot panel's three tabs: Details keeps the basics, Memory holds the memory list, Library lists what the bot made.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SimpleBotPanel } from "./SimpleBotPanel";

const { editor } = vi.hoisted(() => ({ editor: { workspace: false, readOnly: false } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }), visibleMessages: () => [] }));
vi.mock("./BotEditorContext", () => ({ useBotEditor: () => editor }));
vi.mock("./SkillsSection", () => ({ useManagedSkills: () => ({ loading: false, skills: [], reviewing: null }), SkillReviewDialog: () => null }));
vi.mock("./ColonieMemorySection", () => ({ ColonieMemorySection: () => createElement("div", { "data-testid": "memory-list" }, "the memory list") }));
vi.mock("./ColonieSkillsSection", () => ({ ColonieSkillsSection: () => null }));
vi.mock("../Avatar", () => ({ BotAvatar: () => null }));
vi.mock("../SoulField", () => ({ SoulField: () => createElement("textarea", { "aria-label": "Instructions" }) }));
vi.mock("../ChiefControls", () => ({ ChiefControls: () => createElement("div", null, "chief row") }));
vi.mock("../BotConnectedTools", () => ({ BotConnectedTools: () => createElement("div", null, "connected row") }));
vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("../ThreadModelsLine", () => ({ ThreadModelsLine: () => null }));
vi.mock("../FullAccessWarning", () => ({ FullAccessWarning: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { editor.workspace = false; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });

const bot = { id: "b1", name: "Scout", title: "", description: "", threadId: "t", busy: false } as never;
const derived = { patch: vi.fn(), approvalMode: "ask", engine: { driverKind: "codexAcp" }, trustedModesAvailable: true, activeState: "idle" } as never;
const show = (acp = true) => act(async () => {
  root.render(createElement(SimpleBotPanel, { bot, derived, onClose: vi.fn(), onAllSettings: vi.fn(), onAddSkill: vi.fn(), acp }));
});
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Bot settings"] button')];
const pick = (name: string) => act(async () => { tabs().find((tab) => tab.textContent?.trim() === name)!.click(); });
const pressed = () => tabs().filter((tab) => tab.getAttribute("aria-pressed") === "true").map((tab) => tab.textContent?.trim());

test("there are three tabs, Details first, and the memory list is not in Details", async () => {
  await show();
  expect(tabs().map((tab) => tab.textContent?.trim())).toEqual(["Details", "Memory", "Library"]);
  expect(pressed()).toEqual(["Details"]);
  expect(host.querySelector("[data-testid=memory-list]")).toBeNull();
  expect(host.textContent).toContain("Changes apply from your next message");
  expect(host.textContent).toContain("chief row");
  expect(host.textContent).toContain("connected row");
});

test("the Memory tab shows the memory list instead of the details, and Details brings them back", async () => {
  await show();
  await pick("Memory");
  expect(pressed()).toEqual(["Memory"]);
  expect(host.querySelector("[data-testid=memory-list]")).toBeTruthy();
  expect(host.textContent).not.toContain("chief row");
  await pick("Details");
  expect(host.querySelector("[data-testid=memory-list]")).toBeNull();
  expect(host.textContent).toContain("chief row");
});

test("Library still opens its own tab", async () => {
  await show();
  await pick("Library");
  expect(pressed()).toEqual(["Library"]);
  expect(host.textContent).toContain("Scout makes show up here");
  const card = host.querySelector('[role="region"][aria-label="Library"]');
  expect(card?.querySelector("h3")?.textContent).toBe("Nothing in the library yet");
});

test("a workspace bot has only Details, as before", async () => {
  editor.workspace = true;
  await show();
  expect(tabs().map((tab) => tab.textContent?.trim())).toEqual(["Details"]);
});
