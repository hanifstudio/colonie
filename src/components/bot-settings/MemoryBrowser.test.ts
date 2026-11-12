// @vitest-environment happy-dom
// The memory list stays calm at 40+ items: a count, search, groups by kind, five per group until "Show all".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { MemoryEntry, MemoryKind } from "../../../shared/colonie-memory";
import { MemoryBrowser } from "./MemoryBrowser";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });

const entry = (n: number, kind: MemoryKind, text = `memory number ${n}`): MemoryEntry => ({
  id: `m${n}`, scope: n % 2 ? "bot" : "shared", key: `k${n}`, text, kind, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", origin: "person",
});
const many = (): MemoryEntry[] => Array.from({ length: 42 }, (_, i) => entry(i, (["preference", "fact", "decision"] as const)[i % 3]!));
const onEdit = vi.fn();
const onForget = vi.fn();
const show = (entries: MemoryEntry[]) => act(async () => {
  root.render(createElement(MemoryBrowser, { entries, botName: "Scout", caption: () => "Added by you", onEdit, onForget }));
});
const section = (label: string) => host.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
const rows = (label: string) => section(label)?.querySelectorAll("li").length ?? 0;
const buttonIn = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const search = (value: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search memories"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

test("it says how many memories there are and groups them by kind, five at first", async () => {
  await show(many());
  expect(host.textContent).toContain("42 memories");
  expect(["Preferences", "Facts", "Decisions"].map(rows)).toEqual([5, 5, 5]);
  expect(buttonIn(section("Facts")!, "Show all 14")).toBeTruthy();
});

test("Show all opens one group only, and Show fewer closes it again", async () => {
  await show(many());
  await act(async () => { buttonIn(section("Facts")!, "Show all 14")!.click(); });
  expect(rows("Facts")).toBe(14);
  expect(rows("Decisions")).toBe(5);
  await act(async () => { buttonIn(section("Facts")!, "Show fewer")!.click(); });
  expect(rows("Facts")).toBe(5);
});

test("a group of five or fewer has no Show all", async () => {
  await show([entry(1, "fact"), entry(2, "fact")]);
  expect(host.textContent).toContain("2 memories");
  expect(host.textContent).not.toContain("Show all");
  expect(section("Preferences")).toBeNull();
});

test("search narrows the list, counts the matches, and says so when nothing matches", async () => {
  await show([entry(1, "fact", "lives in Jakarta"), entry(2, "preference", "likes short answers"), entry(3, "fact", "works with Dewi")]);
  await search("jakarta");
  expect(host.textContent).toContain("1 of 3 memories");
  expect(rows("Facts")).toBe(1);
  expect(section("Preferences")).toBeNull();
  await search("zzz");
  expect(host.textContent).toContain("No memories match");
  await search("");
  expect(host.textContent).toContain("3 memories");
});

test("Edit and Forget are real buttons on every row, so keyboard and touch reach them, and name the memory", async () => {
  const one = entry(1, "fact", "lives in Jakarta");
  await show([one]);
  const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit memory: lives in Jakarta"]')!;
  const forget = host.querySelector<HTMLButtonElement>('button[aria-label="Forget memory: lives in Jakarta"]')!;
  expect(edit.parentElement!.className).toContain("touch:opacity-100");
  expect(edit.parentElement!.className).toContain("focus-within:opacity-100");
  await act(async () => { edit.click(); forget.click(); });
  expect(onEdit).toHaveBeenCalledWith(one);
  expect(onForget).toHaveBeenCalledWith(one);
});

test("with nothing remembered it shows the empty card and no search box", async () => {
  await show([]);
  expect(host.querySelector('[role="region"][aria-label="Memories"]')).toBeTruthy();
  expect(host.textContent).toContain("Nothing remembered yet");
  expect(host.querySelector('input[aria-label="Search memories"]')).toBeNull();
});
