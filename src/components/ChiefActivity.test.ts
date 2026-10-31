// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChiefActivity } from "./ChiefActivity";
import type { ChiefAssignment } from "../../shared/colonie-chief";

const { api, dispatch, openThread } = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), openThread: vi.fn() }));
vi.mock("@/state/store", () => ({ api, openThread, useStore: () => ({ state: { bots: [{ id: "engineer", name: "Engineer" }] }, dispatch }) }));
const job: ChiefAssignment = { id: "job", chiefBotId: "chief", sourceThreadId: "dm", sourceTurnId: "turn", targetBotId: "engineer", targetThreadId: "work", message: "Inspect the project", status: "running", createdAt: "", updatedAt: "" };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  api.mockResolvedValue({ assignments: [job] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name)!;

test("work starts compact, closes without cancelling, stays closed after updates, and can open the exact task", async () => {
  await act(() => root.render(createElement(ChiefActivity, { botId: "chief", threadId: "dm" })));
  expect(host.textContent).toContain("1 active");
  expect(host.textContent).not.toContain("Inspect the project");
  await act(() => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  expect(host.textContent).toContain("Inspect the project");
  await act(() => button("View work").click());
  expect(openThread).toHaveBeenCalledWith(dispatch, { botId: "engineer", threadId: "work" }, expect.anything());
  await act(() => button("Close work").click());
  api.mockResolvedValue({ assignments: [{ ...job, status: "completed", result: "Verified" }] });
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(host.textContent).toContain("1 past task");
  expect(host.textContent).not.toContain("Verified");
  expect(api.mock.calls.every((call) => call.length === 1 && String(call[0]).startsWith("/api/colonie/chief?"))).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});

test("switching conversations never shows the previous conversation's open work", async () => {
  await act(() => root.render(createElement(ChiefActivity, { botId: "chief", threadId: "dm" })));
  await act(() => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  api.mockResolvedValue({ assignments: [] });
  await act(() => root.render(createElement(ChiefActivity, { botId: "chief", threadId: "other-dm" })));
  expect(host.textContent).toBe("");
});
