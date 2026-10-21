// @vitest-environment happy-dom
// When the app fails, the person sees what happened and a way out, never a
// black screen.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { AppErrorBoundary } from "./AppErrorBoundary";

function Broken(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'at')");
}

afterEach(() => { document.body.innerHTML = ""; delete (window as { colonie?: unknown }).colonie; vi.restoreAllMocks(); });

async function render() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => { createRoot(host).render(createElement(AppErrorBoundary, null, createElement(Broken))); });
  return host;
}

test("a failing screen shows what happened and Reload", async () => {
  const host = await render();
  expect(host.textContent).toContain("Something went wrong");
  expect(host.textContent).toContain("reading 'at'");
  expect(host.querySelector("button")?.textContent).toBe("Reload");
  expect(host.textContent).not.toContain("Back to this computer");
});

test("in the desktop app on a Shared workspace it also offers the way back to this computer", async () => {
  const thisComputer = vi.fn(async () => {});
  (window as { colonie?: unknown }).colonie = { workspaces: { state: async () => ({ local: false, name: "Launch Team" }), menu: async () => {}, thisComputer } };
  const host = await render();
  await act(async () => {});
  const back = [...host.querySelectorAll("button")].find((button) => button.textContent === "Back to this computer");
  expect(back).toBeTruthy();
  await act(async () => { back!.click(); });
  expect(thisComputer).toHaveBeenCalled();
});
