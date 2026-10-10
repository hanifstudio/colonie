import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeDevoneData } from "../../electron/devone-config.mjs";
import { DATA_DIR, loadConfig } from "../config.ts";
import { devoneInstances } from "./profile.ts";

it("seeds a schema-valid default configuration, isolates the ACP engines from the user's CLI, and does not register legacy engines", () => {
  initializeDevoneData(DATA_DIR);
  const config = loadConfig();
  expect(config.defaultModelSelection).toEqual({ instanceId: "codex-acp", model: "agent-default" });
  expect(config.onboarding?.version).toBe(1);
  expect(config.features?.autoRecall).toBe(false);
  const native = join(DATA_DIR, "native");
  const seeded = devoneInstances(config.instances, native);
  expect(Object.keys(seeded)).toEqual(["codex-acp", "claude-acp"]);
  expect(seeded["codex-acp"]!.environment?.CODEX_HOME).toBe(join(native, "codex"));
  expect(seeded["claude-acp"]!.environment?.CLAUDE_CONFIG_DIR).toBe(join(native, "claude"));
  expect(seeded["codex-acp"]!.environment?.HOME).toBeUndefined();
  expect(devoneInstances({ old: { driver: "customAcp" }, codex: { driver: "codex" } }, native)).toEqual({});
});