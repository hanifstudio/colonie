import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeColonieData } from "../../electron/colonie-config.mjs";
import { DATA_DIR, loadConfig } from "../config.ts";
import { colonieInstances } from "./profile.ts";

it("seeds a schema-valid default configuration, isolates the ACP engines from the user's CLI, and does not register legacy engines", () => {
  initializeColonieData(DATA_DIR);
  const config = loadConfig();
  expect(config.defaultModelSelection).toEqual({ instanceId: "codex-acp", model: "agent-default" });
  // A fresh install must NOT be marked onboarding-complete. Phase 1 seeded a
  // completed state to suppress the inherited flow, which hid the welcome
  // flow from every new user; e6576d55 made the flow decide for itself.
  expect(config.onboarding).toEqual({ completedAt: "", version: 0, reelSeen: false, hintsSeen: [] });
  expect(config.features?.autoRecall).toBe(false);
  const native = join(DATA_DIR, "native");
  const seeded = colonieInstances(config.instances, native);
  expect(Object.keys(seeded)).toEqual(["codex-acp", "claude-acp"]);
  expect(seeded["codex-acp"]!.environment?.CODEX_HOME).toBe(join(native, "codex"));
  expect(seeded["claude-acp"]!.environment?.CLAUDE_CONFIG_DIR).toBe(join(native, "claude"));
  expect(seeded["codex-acp"]!.environment?.HOME).toBeUndefined();
  expect(colonieInstances({ old: { driver: "customAcp" }, codex: { driver: "codex" } }, native)).toEqual({});
});