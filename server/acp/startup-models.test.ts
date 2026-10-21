// The model list is there when the app starts.
//
// An ACP engine only reports its models inside a session, so until someone
// opened the model picker the catalog held just "agent-default", and a bot
// created any other way could not choose a real model. An enabled instance now
// starts learning its models when it is created (startupModelRefresh), which
// server/index.ts already waits on behind listen. The fixture is the
// deterministic ACP agent (server/acp/testing/fake-agent.ts), which reports
// the models "fixture" and "fixture-alt".
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { CodexAcpDriver } from "./codex-acp.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const running: Array<{ dir: string; instance: ProviderInstance }> = [];
afterEach(async () => {
  for (const { dir, instance } of running.splice(0)) {
    await instance.dispose?.();
    await removeTempDir(dir);
  }
});

async function instance({ enabled = true, signedIn = true } = {}): Promise<ProviderInstance> {
  const dir = mkdtempSync(join(tmpdir(), "colonie-acp-startup-models-"));
  const stateFile = join(dir, "fixture-state.json");
  if (!signedIn) writeFileSync(stateFile, JSON.stringify({ authenticated: false, sessions: {} }));
  const created = await CodexAcpDriver.create({
    instanceId: "codex-acp",
    displayName: "Codex",
    enabled,
    environment: { COLONIE_FAKE_STATE: stateFile, CODEX_HOME: dir },
    config: CodexAcpDriver.decodeConfig({
      cli: process.execPath,
      args: ["--experimental-strip-types", join(import.meta.dirname, "testing", "fake-agent.ts")],
    }),
  });
  running.push({ dir, instance: created });
  return created;
}

const modelIds = (instance: ProviderInstance) => instance.models.options.map((option) => option.id);

test("an enabled engine learns its models at start, without anyone opening the picker", async () => {
  const engine = await instance();
  expect(engine.startupModelRefresh, "an enabled ACP instance starts its model discovery when created").toBeDefined();
  await engine.startupModelRefresh;
  expect(modelIds(engine)).toEqual(expect.arrayContaining(["agent-default", "fixture", "fixture-alt"]));
});

test("creating the instance does not wait for the discovery", async () => {
  // server/index.ts listens before the catalogs land; creation must return
  // while discovery is still running, not after it.
  const engine = await instance();
  expect(modelIds(engine)).toEqual(["agent-default"]);
  await engine.startupModelRefresh;
});

test("opening the picker while the start-up discovery runs does not start the engine twice", async () => {
  const engine = await instance();
  await Promise.all([engine.startupModelRefresh, engine.refreshModels?.(), engine.refreshModels?.()]);
  const { dir } = running.at(-1)!;
  const sessions = Object.keys(JSON.parse(readFileSync(join(dir, "fixture-state.json"), "utf8")).sessions);
  expect(sessions, "one discovery session serves every caller that asked while it ran").toHaveLength(1);
  expect(modelIds(engine)).toContain("fixture-alt");
});

test("the discovery session closes once the models are known", async () => {
  // Discovery runs for every enabled engine at start. Its throwaway session
  // used to idle for five minutes, one engine process each; now it closes as
  // soon as the list is read, so the next refresh has to open a new one (and
  // sees what changed, such as a sign-in).
  const engine = await instance();
  await engine.startupModelRefresh;
  await engine.refreshModels?.();
  const { dir } = running.at(-1)!;
  const sessions = Object.keys(JSON.parse(readFileSync(join(dir, "fixture-state.json"), "utf8")).sessions);
  expect(sessions).toHaveLength(2);
});

test("a disabled engine starts nothing", async () => {
  const engine = await instance({ enabled: false });
  expect(engine.startupModelRefresh).toBeUndefined();
  expect(modelIds(engine)).toEqual(["agent-default"]);
});

test("a signed-out engine settles quietly and keeps the default model", async () => {
  const engine = await instance({ signedIn: false });
  expect(engine.startupModelRefresh).toBeDefined();
  await expect(engine.startupModelRefresh).resolves.toBeUndefined();
  expect(modelIds(engine)).toContain("agent-default");
});
