import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RoutineRunCard } from "./RoutineRunCard";
import type { Message } from "@/state/store";

const message = (summary: string, status = "completed"): Message => ({
  id: "report", at: 1, role: "bot", kind: "routine.run", routineRun: {
    runId: "run", routineId: "routine", routineName: "Launch report", scheduledFor: 1, status, summary,
  },
} as Message);

test("a completed report uses the chat's formatting and clickable source links", () => {
  const html = renderToStaticMarkup(createElement(RoutineRunCard, { message: message("**Ready**. [Checklist](https://example.com/checklist)") }));
  expect(html).toContain("<strong>Ready</strong>");
  expect(html).toContain('href="https://example.com/checklist"');
  expect(html).not.toContain("**Ready**");
});

test("a long report can be expanded without losing its final source", () => {
  const html = renderToStaticMarkup(createElement(RoutineRunCard, { message: message(`${"Launch progress. ".repeat(30)}\n\n[Source](https://example.com/report)`) }));
  expect(html).toContain("<details");
  expect(html).toContain('href="https://example.com/report"');
});
