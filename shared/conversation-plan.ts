// The step list a bot keeps for the job it is on ("Find footage", "Cut to the voice-over", "Render").
// The engine sends the whole list every time it changes; Colonie shows one card per turn that is replaced in
// place. Both engines Colonie runs (Claude and Codex, through their ACP adapters) send the same shape. Shared
// so the server that stores it and the screen that draws it agree on what a step is and when it counts as running.

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface ConversationPlan {
  steps: PlanStep[];
  /** The turn has ended: no step is running any more, whatever the last list said. */
  ended?: boolean;
  /** The turn ended in failure or was stopped, so the card says "Stopped" if steps are left. */
  stopped?: boolean;
}

/** Bounds, so one runaway list cannot flood a transcript. Over the limit the rest is dropped. */
export const PLAN_STEP_LIMIT = 100;
export const PLAN_STEP_TEXT_LIMIT = 300;

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** The steps of an engine's plan update, inside the bounds: blank steps dropped, spacing tidied, an unknown
 * status read as not started. The engine's own spelling is `{ content, status }`. */
export function clampPlanSteps(entries: unknown): PlanStep[] {
  if (!Array.isArray(entries)) return [];
  const steps: PlanStep[] = [];
  for (const entry of entries) {
    if (steps.length >= PLAN_STEP_LIMIT) break;
    if (!entry || typeof entry !== "object") continue;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string") continue;
    const text = content.replace(/\s+/gu, " ").trim().slice(0, PLAN_STEP_TEXT_LIMIT);
    if (!text) continue;
    steps.push({ text, status: typeof status === "string" && STATUSES.has(status) ? (status as PlanStepStatus) : "pending" });
  }
  return steps;
}

/** The plan as a Markdown checklist. It is the stored message's text, so anything that reads only text (the
 * transcript export, a client that does not know plans) still shows a readable list. */
export function planText(steps: readonly PlanStep[]): string {
  return steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`).join("\n");
}

export type PlanStepState = "done" | "active" | "pending";

/** How a step shows. A step runs only while its turn runs: once the turn has ended, a step that was not
 * finished shows as not started, so a stopped bot never shows a step still turning. */
export function planStepState(plan: ConversationPlan, step: PlanStep): PlanStepState {
  if (step.status === "completed") return "done";
  return step.status === "in_progress" && !plan.ended ? "active" : "pending";
}

export function planProgress(plan: ConversationPlan): { done: number; total: number; active?: string; stopped: boolean } {
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const active = plan.steps.find((step) => planStepState(plan, step) === "active")?.text;
  return { done, total: plan.steps.length, ...(active ? { active } : {}), stopped: Boolean(plan.stopped) && done < plan.steps.length };
}
