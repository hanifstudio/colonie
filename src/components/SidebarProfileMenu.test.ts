// @vitest-environment happy-dom
// The profile menu at the bottom left of the sidebar: it is where the app's own pages are, never where a
// person edits who they are. Even with a signed-in account that has a photo page, there is no "Change photo".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: undefined }, dispatch: () => {} }) }));

import { SidebarProfileMenu } from "./SidebarProfileMenu";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

test("with a photo page on the account, the menu lists Settings, Keyboard shortcuts and About, and no Change photo", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    account: { name: "Mila Sona", email: "mila@x.dev", photoUrl: "https://cloud.example/photo" },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await act(async () => { root.render(createElement(SidebarProfileMenu)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  // the row still shows who is signed in
  expect(host.textContent).toContain("Mila Sona");
  expect(host.textContent).toContain("mila@x.dev");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click(); });
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? "");
  expect(items.some((text) => text.includes("Settings"))).toBe(true);
  expect(items.some((text) => text.includes("Keyboard shortcuts"))).toBe(true);
  expect(items.some((text) => text.includes("About"))).toBe(true);
  expect(items.some((text) => /photo/i.test(text))).toBe(false);
});
