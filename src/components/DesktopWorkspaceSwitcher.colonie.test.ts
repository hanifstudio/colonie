// Colonie's account desktop reports this window's own Local workspace through
// `window.ogb.colonieWorkspaces`. The original sidebar switcher must name it
// and open the Cloud from the same button, and must leave the saved-server
// bridge untouched when no Colonie controller answers.
//
// happy-dom is bootstrapped inside this node-environment file so the async
// info() effect actually runs, the same way
// src/components/colonie-platform/platform-flow.test.ts does it. Import order
// is load-bearing: the DOM globals must exist before React DOM is imported.
import { Window } from "happy-dom";

const testWindow = new Window({ url: "http://127.0.0.1:41234/" });
const globals = globalThis as unknown as Record<string, unknown>;
const setGlobal = (key: string, value: unknown) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
};
setGlobal("window", testWindow);
setGlobal("document", testWindow.document);
setGlobal("navigator", testWindow.navigator);
setGlobal("location", testWindow.location);
setGlobal("history", testWindow.history);
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "getComputedStyle"]) {
  setGlobal(key, (testWindow as unknown as Record<string, unknown>)[key] ?? globals[key]);
}

import { act, createElement } from "react";
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
import { afterEach, expect, it, vi } from "vitest";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";

/** The renderer's `window.ogb` bridge, replaced per test. */
const ogb = (value: unknown) => { Object.defineProperty(testWindow, "ogb", { value, writable: true, configurable: true }); };

let root: Root | null = null;
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  ogb(undefined);
  document.body.innerHTML = "";
});

/** Let the resolved info()/state() promise settle inside act. */
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root!.render(createElement(DesktopWorkspaceSwitcher, { inline: true })); });
  return host;
}

it("names Colonie's own Local workspace in the original switcher and opens its Cloud", async () => {
  const cloud = vi.fn(async () => {});
  ogb({
    colonieWorkspaces: {
      info: async () => ({ origin: "https://cloud.test", local: { id: "l1", name: "Ada's Mac", origin: "http://127.0.0.1:41234" } }),
      cloud,
    },
  });

  const host = mount();
  await flush();

  const button = host.querySelector("button")!;
  expect(host.textContent).toContain("Ada's Mac");
  expect(button.getAttribute("aria-label")).toBe("Switch server: Ada's Mac");
  // A Local workspace is not a Cloud home: no added indicator, no new chrome.
  expect(host.querySelector("[data-cloud-home-indicator]")).toBeNull();

  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(cloud).toHaveBeenCalledTimes(1);
});

it("keeps the saved-server bridge when Colonie does not answer", async () => {
  const cloud = vi.fn(async () => {});
  const menu = vi.fn(async () => {});
  ogb({
    colonieWorkspaces: { info: async () => { throw new Error("No Colonie controller"); }, cloud },
    workspaces: { state: async () => ({ local: true, name: "This computer" }), menu },
  });

  const host = mount();
  await flush();

  expect(host.textContent).toContain("This computer");
  const button = host.querySelector("button")!;
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(menu).toHaveBeenCalledTimes(1);
  expect(cloud).not.toHaveBeenCalled();
});