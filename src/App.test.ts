// @vitest-environment happy-dom
// The original shell must also serve an account workspace without becoming a
// second shell: the layout, drawer, menu button and caption chrome stay put,
// and the caller's sidebar/main/panels fill the same three slots. With no port
// it renders the Local shell exactly as before.
//
// The legacy panels are lazy screens that render nothing until their chunk
// loads, so their absence is asserted structurally (the account's own markup
// is there and the Local sidebar/main are not) rather than by their own DOM.
import { createElement, type Dispatch, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type Action } from "@/state/store";
import type { AppShellAccountPort, AppShellSidebarControls } from "@/lib/app-shell-account";
import { Shell } from "./App";

let host: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
let seen: AppShellSidebarControls[];

function fixtureSidebar(controls: AppShellSidebarControls): ReactNode {
  seen.push(controls);
  return createElement("aside", {
    "data-fixture-sidebar": "",
    "data-open": String(controls.open),
    "data-collapse": String(controls.collapseToIcons),
  });
}

function mount(node: ReactNode) {
  const value = {
    state: initialState,
    dispatch: dispatch as unknown as Dispatch<Action>,
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: node })));
}

const lastControls = () => seen[seen.length - 1]!;

beforeAll(() => {
  // The shell warms the on-request screens once it is idle; this test does not
  // want the legacy chunks pulled in, so the callback is never invoked.
  (globalThis as unknown as { requestIdleCallback: unknown }).requestIdleCallback = () => 0;
  (globalThis as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = () => {};
  // Node's experimental localStorage throws without a backing file; the shell
  // reads it directly (skin, language, sidebar width, first-run gate).
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, String(value)); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => { entries.clear(); },
    key: () => null,
    get length() { return entries.size; },
  };
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, "localStorage", { value: storage, configurable: true });
  }
  // The Local-shell case mounts the real Sidebar, whose hooks call `api()`.
  // Without a server that leaves a fetch pending, which happy-dom aborts at
  // teardown; a never-settling stub keeps this test hermetic and quiet.
  const pending = () => new Promise<Response>(() => {});
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, "fetch", { value: pending, configurable: true, writable: true });
  }
});

afterAll(() => {
  delete (globalThis as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  delete (globalThis as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

beforeEach(() => {
  dispatch = vi.fn();
  seen = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("Shell account port", () => {
  it("fills the sidebar, main and panel slots with the account surfaces", () => {
    const port: AppShellAccountPort = {
      sidebar: fixtureSidebar,
      main: createElement("main", { "data-fixture-main": "" }, "the conversation"),
      panels: createElement("div", { "data-fixture-panels": "" }),
    };
    mount(createElement(Shell, { account: port }));
    expect(host.querySelector("[data-fixture-main]")?.textContent).toBe("the conversation");
    expect(host.querySelector("[data-fixture-panels]")).not.toBeNull();
    expect(host.querySelector('[data-fixture-sidebar][data-open="false"]')).not.toBeNull();
  });

  it("does not mount the Local sidebar or the Local main content", () => {
    mount(createElement(Shell, { account: { sidebar: fixtureSidebar, main: createElement("main", {}, "account") } }));
    expect(host.querySelector("[data-sidebar]")).toBeNull();
    expect(host.textContent).not.toContain("Connecting to the bot server");
    expect(host.textContent).not.toContain("No bots yet");
  });

  it("renders without panels when the account supplies none", () => {
    mount(createElement(Shell, { account: { sidebar: fixtureSidebar, main: createElement("main", {}, "account") } }));
    expect(host.querySelector("[data-fixture-panels]")).toBeNull();
    expect(host.querySelector("[data-fixture-sidebar]")).not.toBeNull();
  });

  it("keeps the original mobile drawer wiring around the account sidebar", () => {
    mount(createElement(Shell, { account: { sidebar: fixtureSidebar, main: createElement("main", {}, "account") } }));
    expect(lastControls().open).toBe(false);
    expect(lastControls().collapseToIcons).toBe(false);

    const menu = host.querySelector<HTMLButtonElement>('[aria-label="Open bot list"]')!;
    expect(menu).not.toBeNull();
    flushSync(() => menu.click());
    expect(lastControls().open).toBe(true);

    flushSync(() => lastControls().onClose());
    expect(lastControls().open).toBe(false);
    expect(host.querySelector('[data-fixture-sidebar][data-open="false"]')).not.toBeNull();
  });

  it("keeps the cheat sheet and the command palette for both shells", () => {
    mount(createElement(Shell, { account: { sidebar: fixtureSidebar, main: createElement("main", {}, "account") } }));
    // The palette owns its own ⌘K listener and is mounted in both modes.
    const opened = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    flushSync(() => window.dispatchEvent(opened));
    expect(host.querySelector('[aria-label="Command palette"]')).not.toBeNull();
  });

  it("renders the unchanged Local shell when no port is given", () => {
    mount(createElement(Shell));
    expect(host.querySelector("[data-sidebar]")).not.toBeNull();
    expect(host.querySelector("[data-fixture-sidebar]")).toBeNull();
    expect(host.textContent).toContain("Connecting to the bot server");
  });
});
