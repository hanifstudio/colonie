import { expect, test } from "vitest";

import { clampPlanSteps, PLAN_STEP_LIMIT, PLAN_STEP_TEXT_LIMIT, planProgress, planStepState, planText, type ConversationPlan } from "./conversation-plan.ts";

test("an engine's plan update becomes steps inside the bounds", () => {
  const steps = clampPlanSteps([
    { content: "  Find   the\nfootage ", status: "completed", priority: "high" },
    { content: "Cut to the voice-over", status: "in_progress" },
    { content: "   ", status: "pending" },
    { content: "Render", status: "something-new" },
    { status: "pending" },
    "not an entry",
    null,
  ]);
  expect(steps).toEqual([
    { text: "Find the footage", status: "completed" },
    { text: "Cut to the voice-over", status: "in_progress" },
    { text: "Render", status: "pending" },
  ]);
});

test("a runaway list is cut at the limit and a long step is shortened", () => {
  const many = Array.from({ length: PLAN_STEP_LIMIT + 40 }, (_, index) => ({ content: `step ${index}`, status: "pending" }));
  expect(clampPlanSteps(many)).toHaveLength(PLAN_STEP_LIMIT);
  expect(clampPlanSteps([{ content: "x".repeat(PLAN_STEP_TEXT_LIMIT + 50), status: "pending" }])[0]!.text).toHaveLength(PLAN_STEP_TEXT_LIMIT);
  expect(clampPlanSteps("nothing")).toEqual([]);
  expect(clampPlanSteps([])).toEqual([]);
});

test("the plan reads as a Markdown checklist for anything that only reads text", () => {
  expect(planText([{ text: "Find footage", status: "completed" }, { text: "Render", status: "in_progress" }, { text: "Check", status: "pending" }]))
    .toBe("- [x] Find footage\n- [ ] Render\n- [ ] Check");
});

test("a step runs only while its turn runs; after the turn it shows as not started", () => {
  const live: ConversationPlan = { steps: [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }] };
  expect(live.steps.map((step) => planStepState(live, step))).toEqual(["done", "active", "pending"]);
  const ended: ConversationPlan = { ...live, ended: true, stopped: true };
  expect(ended.steps.map((step) => planStepState(ended, step))).toEqual(["done", "pending", "pending"]);
});

test("progress counts the finished steps, names the running one, and says stopped only when steps are left", () => {
  const steps = [{ text: "a", status: "completed" as const }, { text: "Cutting the video", status: "in_progress" as const }];
  expect(planProgress({ steps })).toEqual({ done: 1, total: 2, active: "Cutting the video", stopped: false });
  expect(planProgress({ steps, ended: true, stopped: true })).toEqual({ done: 1, total: 2, stopped: true });
  // all done and the turn ended badly afterwards: nothing is left, so it is not "stopped"
  expect(planProgress({ steps: [{ text: "a", status: "completed" }], ended: true, stopped: true }).stopped).toBe(false);
});
