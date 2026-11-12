// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MonitorIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import { Button } from "./Button";
import { EmptyCard } from "./EmptyCard";
import { StatusDot } from "./StatusDot";
import { TabPills } from "./TabPills";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
const render = (node: ReturnType<typeof createElement>) => act(async () => { root.render(node); });

test("a button is a plain button by default, never a form submit, and each kind looks like itself", async () => {
  const click = vi.fn();
  await render(createElement("div", null,
    createElement(Button, { variant: "primary", onClick: click }, "Do it"),
    createElement(Button, null, "Other"),
    createElement(Button, { variant: "quiet" }, "Link"),
    createElement(Button, { disabled: true, onClick: click }, "Off")));
  const [primary, secondary, quiet, disabled] = [...host.querySelectorAll("button")];
  expect(primary!.type).toBe("button");
  expect(primary!.className).toContain("bg-accent");
  expect(secondary!.className).toContain("bg-raised");
  expect(quiet!.className).toContain("underline");
  await act(async () => { primary!.click(); disabled!.click(); });
  expect(click).toHaveBeenCalledOnce();
  // every kind can be reached and seen with the keyboard
  for (const button of [primary, secondary, quiet]) expect(button!.className).toContain("focus-visible:ring-2");
});

test("tab pills press one tab, call back with its id, and show what follows a label", async () => {
  const pick = vi.fn();
  await render(createElement(TabPills<"a" | "b">, {
    label: "Panel view", value: "a", onChange: pick,
    tabs: [{ id: "a", label: "Screen", icon: MonitorIcon, after: createElement(StatusDot, { label: "in use", testId: "dot" }) }, { id: "b", label: "Files", icon: Folder01Icon }],
  }));
  const [first, second] = [...host.querySelectorAll("button")];
  expect(host.querySelector("[aria-label='Panel view']")).not.toBeNull();
  expect([first!.getAttribute("aria-pressed"), second!.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
  expect(host.querySelector("[data-testid=dot]")?.getAttribute("aria-label")).toBe("in use");
  await act(async () => { second!.click(); });
  expect(pick).toHaveBeenCalledWith("b");
});

test("an empty card names its region, and says what went wrong as an alert", async () => {
  await render(createElement(EmptyCard, { label: "Scout's screen", icon: null, title: "Nothing yet", body: "Say why.", problem: "It broke." }, createElement(Button, null, "Retry")));
  expect(host.querySelector("[role=region]")?.getAttribute("aria-label")).toBe("Scout's screen");
  expect(host.querySelector("h3")?.textContent).toBe("Nothing yet");
  expect(host.querySelector("[role=alert]")?.textContent).toBe("It broke.");
  expect(host.querySelector("button")?.textContent).toBe("Retry");
});

test("a secondary button and an off switch keep a visible edge, so they read as controls on light skins", async () => {
  const { Switch } = await import("../SettingsPrimitives");
  await render(createElement("div", null,
    createElement(Button, null, "Edit"),
    createElement(Switch, { checked: false, "aria-label": "off" }),
    createElement(Switch, { checked: true, "aria-label": "on" })));
  const [button] = [...host.querySelectorAll("button")];
  expect(button!.className).toContain("ring-edge");
  const [off, on] = [...host.querySelectorAll<HTMLElement>('[role="switch"]')];
  expect(off!.className).toContain("ring-edge");
  expect(on!.className).not.toContain("ring-edge");
  expect(off!.querySelector("span")!.className).toContain("shadow-sm");
});
