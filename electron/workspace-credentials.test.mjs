// The boot sweep removes what a removed feature (avatar image generation) left behind, and nothing else.
import { expect, test } from "vitest";
import { migrateWorkspaceCredentials } from "./workspace-credentials.mjs";

test("a retired avatar image key is removed from the config and from the stored secrets", () => {
  const config = { imageGen: { provider: "openai", key: "not-a-real-key" }, tts: { voice: "v1" } };
  const credentials = { openaiImageApiKey: "not-a-real-key", customImageApiKey: "x", ttsKey: "kept" };

  const result = migrateWorkspaceCredentials(config, credentials);

  expect(result.config).toEqual({ tts: { voice: "v1" } });
  expect(result.credentials).toEqual({ ttsKey: "kept" });
  expect(result.configChanged).toBe(true);
  expect(result.credentialsChanged).toBe(true);
});

test("a config and secrets without them are left alone", () => {
  const config = { tts: { voice: "v1" } };
  const credentials = { ttsKey: "kept" };

  const result = migrateWorkspaceCredentials(config, credentials);

  expect(result).toMatchObject({ config, credentials, configChanged: false, credentialsChanged: false });
});
