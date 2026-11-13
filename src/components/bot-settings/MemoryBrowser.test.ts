// @vitest-environment happy-dom
// The memory list stays simple at 40+ items: one plain list, eight lines until "Show all", search only when long.
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
const rows = () => host.querySelectorAll("ul[aria-label='Memories'] li").length;
const buttonIn = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const search = (value: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search memories"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

test("a long list shows eight lines, a search box and Show all", async () => {
  await show(many());
  expect(rows()).toBe(8);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search memories"]')!.placeholder).toBe("Search 42 memories");
  expect(buttonIn(host, "Show all 42")).toBeTruthy();
});

test("Show all opens the whole list, and Show fewer closes it again", async () => {
  await show(many());
  await act(async () => { buttonIn(host, "Show all 42")!.click(); });
  expect(rows()).toBe(42);
  await act(async () => { buttonIn(host, "Show fewer")!.click(); });
  expect(rows()).toBe(8);
});

test("a short list has no search box and no Show all", async () => {
  await show([entry(1, "fact"), entry(2, "fact")]);
  expect(rows()).toBe(2);
  expect(host.textContent).not.toContain("Show all");
  expect(host.querySelector('input[aria-label="Search memories"]')).toBeNull();
});

test("search narrows the whole list and says so when nothing matches", async () => {
  await show([...many(), entry(100, "fact", "lives in Jakarta")]);
  await search("jakarta");
  expect(rows()).toBe(1);
  await search("zzz");
  expect(host.textContent).toContain("No memories match");
  await search("");
  expect(rows()).toBe(8);
});

test("the source of a memory is a tooltip, not a second line", async () => {
  await show([entry(1, "fact", "lives in Jakarta")]);
  expect(host.querySelector("li")!.title).toBe("Added by you");
  expect(host.textContent).not.toContain("Added by you");
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
