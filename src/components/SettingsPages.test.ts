// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BuiltInBrowserRow, GeneralSettings, ProfileFields } from "./SettingsModal";
import { ComposioCredentialPanel } from "./ComposioCredentialPanel";
import { DefaultBotSettings } from "./NewBotDialog";
import { SKINS } from "@/lib/skins";

const { api, storeState } = vi.hoisted(() => ({ api: vi.fn(), storeState: { current: {} as Record<string, unknown> } }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api,
  useStore: () => ({ state: storeState.current, dispatch: vi.fn() }),
}));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  readSessionState: async () => ({}),
  isOwnerOrAdmin: () => true,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async () => ({ learned: [] }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const draw = async (node: Parameters<Root["render"]>[0]) => { await act(async () => { root.render(node); }); await act(async () => {}); };
const buttonNamed = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);

const config = (browserEngine: Record<string, unknown>, browser = true) => ({
  features: { browser }, browserEngine, browserProfiles: [], profile: { name: "", email: "" },
});

test("Browser: a missing engine shows one Install action, no switch, and no pointer back to this page", async () => {
  storeState.current = { config: config({ kind: "unavailable", installable: true }), bots: [] };
  await draw(createElement(BuiltInBrowserRow));
  expect(buttonNamed("Install browser engine")).toBeDefined();
  expect(host.querySelector("[role=switch]")).toBeNull();
  expect(host.textContent).toContain("not installed yet");
  expect(host.textContent).not.toContain("App Settings");
  await act(async () => { buttonNamed("Install browser engine")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/browser-engine/install", { method: "POST" });
});

test("Browser: with the engine installed the switch is the whole control", async () => {
  storeState.current = { config: config({ kind: "engine" }), bots: [] };
  await draw(createElement(BuiltInBrowserRow));
  expect(buttonNamed("Install browser engine")).toBeUndefined();
  const toggle = host.querySelector<HTMLButtonElement>("[role=switch]")!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).not.toContain("not installed");
  expect(host.textContent).not.toContain("App Settings");
});

test("Account: name, email and About me each have a visible label", async () => {
  storeState.current = { config: config({ kind: "engine" }), bots: [] };
  await draw(createElement(ProfileFields));
  const labels = [...host.querySelectorAll("label")].map((label) => label.textContent);
  expect(labels).toEqual(expect.arrayContaining(["Your name", "Email", "About me"]));
  for (const label of host.querySelectorAll("label")) {
    expect(host.querySelector(`#${label.htmlFor}`), label.textContent ?? "").not.toBeNull();
  }
});

test("AI: the Composio key details sit behind a Details disclosure", async () => {
  api.mockImplementation(async () => ({ available: true, maskedKey: "ak_Hgm••••HRK9", source: "environment", origin: "environment", canRemove: false, storage: "available" }));
  storeState.current = { config: { composio: {} }, bots: [] };
  await draw(createElement(ComposioCredentialPanel, { onStatus: () => {} }));
  const details = host.querySelector("details[data-composio-key-details]")!;
  expect(details).not.toBeNull();
  expect(details.querySelector("summary")?.textContent).toBe("Details");
  expect(details.textContent).toContain("Provided by the runtime environment");
  expect(details.hasAttribute("open")).toBe(false);
  // nothing technical outside the disclosure
  expect(host.textContent!.replace(details.textContent!, "")).not.toContain("runtime environment");
});

test("General: Language comes first and Advanced mode sits in the last group", async () => {
  storeState.current = { config: config({ kind: "engine" }), bots: [], instances: [] };
  await draw(createElement(GeneralSettings, { shared: false, fleet: false, advanced: false, remoteActive: false }));
  const text = host.textContent!;
  expect(text.indexOf("Language")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Language")).toBeLessThan(text.indexOf("Defaults for new bots"));
  expect(text.indexOf("Language")).toBeLessThan(text.indexOf("Advanced mode"));
  const last = host.querySelector("[data-settings-group=advanced]")!;
  expect(last.textContent).toContain("Advanced mode");
  expect(host.lastElementChild).toBe(last);
});

test("General: both defaults actions are the same kind of Button, under a description", async () => {
  storeState.current = { config: config({ kind: "engine" }), bots: [] };
  await draw(createElement(DefaultBotSettings));
  const share = buttonNamed("Share as preset…")!;
  const edit = buttonNamed("Edit")!;
  expect(host.textContent).toContain("every new bot starts with");
  expect(share.className).toBe(edit.className);
  expect(edit.className).toContain("bg-raised");
});

test("Skins: each one-line description says what the look is", () => {
  for (const skin of SKINS) expect(skin.tagline).not.toMatch(/original|Colonie look/i);
});
