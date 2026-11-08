import { expect, test } from "vitest";
import { sessionFailureOf, SESSION_FAILURE_CLIENT_META } from "./session-failure.ts";

const meta = (failure: Record<string, unknown>) => ({ jetbrains: { air: { version: 1, sessionFailure: failure } } });

test("the client asks for the engines' failure reports under the name both adapters read", () => {
  expect(JSON.stringify(SESSION_FAILURE_CLIENT_META)).toContain('"sessionFailure"');
});

test("an engine's failure is read as its title and details, with secrets removed", () => {
  expect(sessionFailureOf(meta({ kind: "quota_exhausted", severity: "error", title: "The Claude account has no available quota." })))
    .toEqual({ kind: "quota_exhausted", text: "The Claude account has no available quota." });
  expect(sessionFailureOf(meta({ kind: "rate_limited", severity: "error", title: "Rate limited.", details: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz was refused" }))?.text)
    .not.toContain("abcdefghijklmnopqrstuvwxyz");
});

test("a warning, a missing title, and unrelated meta are not failures", () => {
  expect(sessionFailureOf(meta({ kind: "rate_limited", severity: "warning", title: "Retrying in 5s" }))).toBeUndefined();
  expect(sessionFailureOf(meta({ kind: "quota_exhausted", severity: "error" }))).toBeUndefined();
  expect(sessionFailureOf({ claudeCode: {} })).toBeUndefined();
  expect(sessionFailureOf(undefined)).toBeUndefined();
});
