// A new bot gets the saved engine while it can run, and otherwise an engine
// that can run now, so a signed-in Claude is never blocked by a signed-out
// saved Codex.
import { expect, test } from "vitest";

import { selectDefaultModelSelection, type SelectableInstance } from "./default-model-selection.ts";

const engine = (instanceId: string, driverKind: string, authenticated: boolean): SelectableInstance => ({
  instanceId, driverKind, snapshot: { state: "available", authenticated } as SelectableInstance["snapshot"],
  models: { default: "agent-default", options: [{ id: "agent-default", label: "Default" }] },
});
const codexSaved = { instanceId: "codex-acp", model: "agent-default" };

test("a saved engine that can run is kept", () => {
  expect(selectDefaultModelSelection([engine("codex-acp", "codex-acp", true), engine("claude-acp", "claude-acp", true)], codexSaved)).toEqual(codexSaved);
});

test("a signed-out saved engine gives way to one that is signed in", () => {
  expect(selectDefaultModelSelection([engine("codex-acp", "codex-acp", false), engine("claude-acp", "claude-acp", true)], codexSaved))
    .toEqual({ instanceId: "claude-acp", model: "agent-default" });
});

test("without a saved choice Claude comes first among engines that can run", () => {
  expect(selectDefaultModelSelection([engine("codex-acp", "codex-acp", true), engine("claude-acp", "claude-acp", true)]).instanceId).toBe("claude-acp");
});

test("with nothing signed in, a saved choice still sends new bots to setup", () => {
  expect(selectDefaultModelSelection([engine("codex-acp", "codex-acp", false), engine("claude-acp", "claude-acp", false)], codexSaved))
    .toEqual({ instanceId: "", model: "" });
});
