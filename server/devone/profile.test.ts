import { expect, it } from "vitest";
import { initializeDevoneData } from "../../electron/devone-config.mjs";
import { DATA_DIR, loadConfig } from "../config.ts";
import { devoneInstances } from "./profile.ts";

it("seeds a schema-valid default configuration and does not register legacy engines", () => {
  initializeDevoneData(DATA_DIR);
  const config = loadConfig();
  expect(config.defaultModelSelection).toEqual({ instanceId: "codex-acp", model: "agent-default" });
  expect(config.onboarding?.version).toBe(1);
  expect(config.features?.autoRecall).toBe(false);
  expect(devoneInstances(config.instances)).toEqual(config.instances);
  expect(devoneInstances({ old: { driver: "customAcp" }, codex: { driver: "codex" } })).toEqual({});
});
