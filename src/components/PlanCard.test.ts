// @vitest-environment happy-dom
// A bot's step list card: open while the bot works, folded after, honest about unfinished and stopped steps.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { ConversationPlan } from "../../shared/conversation-plan";
import { PlanCard } from "./PlanCard";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); });

const steps = [
  { text: "Find footage", status: "completed" as const },
  { text: "Cut to the voice-over", status: "in_progress" as const },
  { text: "Render the video", status: "pending" as const },
];
const show = (plan: ConversationPlan) => act(() => root.render(createElement(PlanCard, { plan })));
const toggle = () => host.querySelector<HTMLButtonElement>("button")!;
const items = () => [...host.querySelectorAll("li")].map((li) => li.textContent);

test("while the bot works the list is open and says how far it is", async () => {
  await show({ steps });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(toggle().textContent).toContain("Steps");
  expect(toggle().textContent).toContain("1 of 3 done");
  expect(items()).toEqual(["Done: Find footage", "In progress: Cut to the voice-over", "Not started: Render the video"]);
  expect(host.querySelector("[class*='animate-spin']")).not.toBeNull();
});

test("once the turn ends it folds to one line, and the person can open it again", async () => {
  await show({ steps, ended: true });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(items()).toEqual([]);
  await act(async () => { toggle().click(); });
  expect(items()).toHaveLength(3);
  // nothing spins after the end: the unfinished step reads as not started
  expect(items()[1]).toBe("Not started: Cut to the voice-over");
  expect(host.querySelector("[class*='animate-spin']")).toBeNull();
});

test("a stopped turn with steps left is titled Stopped", async () => {
  await show({ steps, ended: true, stopped: true });
  expect(toggle().textContent).toContain("Stopped");
});

test("an empty list shows nothing", async () => {
  await show({ steps: [] });
  expect(host.innerHTML).toBe("");
});
