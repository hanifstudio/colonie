// What crosses from the launching shell into a fixture server: only what a
// test scripted on purpose. A real OpenAI key must never reach a fixture that
// could send it to OpenAI.
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../server/testing/cleanup.ts";
import { fakeAcpInstanceEnvironment, launchVerificationServer, verificationServerConfig, verificationServerEnvironment } from "./control-colonie.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) => verificationServerEnvironment(parentEnv, join(tmpdir(), "colonie-fixture-env"), 9100);

describe("the fixture's Live call environment", () => {
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(childEnv({ COLONIE_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ", COLONIE_OPENAI_LIVE_KEY: "sk-fake" }))
      .toMatchObject({ COLONIE_OPENAI_LIVE_URL: "http://127.0.0.1:4100", COLONIE_OPENAI_LIVE_KEY: "sk-fake" });
    const noKey = childEnv({ COLONIE_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.COLONIE_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("COLONIE_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of ["https://api.openai.com", "http://localhost:4100", "http://127.0.0.1:4100/v1", "http://192.0.2.1:4100", "http://127.0.0.1", ""]) {
      const env = childEnv({ COLONIE_OPENAI_LIVE_URL: url, COLONIE_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("COLONIE_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("COLONIE_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ COLONIE_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty("COLONIE_OPENAI_LIVE_KEY");
  });
});

describe("the fixture's fake ACP instance configuration", () => {
  const instances = (config: Record<string, unknown>) => config.instances as Record<string, { environment: Record<string, string> }>;
  const dataDir = join(tmpdir(), "colonie-fixture-config");

  it("keeps the default fixture configuration unchanged", () => {
    const { config, fixtureDumpPath, gateDirs } = verificationServerConfig(dataDir);
    expect(Object.keys(instances(config))).toEqual(["claude"]);
    expect(instances(config).claude.environment).toEqual({ FAKE_ACP_MODES: "default,bypassPermissions" });
    expect(fixtureDumpPath).toBe(join(dataDir, "fake-claude-dump.json"));
    expect(gateDirs).toBeUndefined();
    const withCodex = instances(verificationServerConfig(dataDir, { extraProviders: ["codex"], room: { scripted: true } }).config);
    expect(withCodex.codex.environment).toEqual({ FAKE_ACP_MODES: "read-only,agent-full-access" });
    expect(withCodex.claude.environment).toEqual({ FAKE_ACP_MODES: "default,bypassPermissions", FAKE_CLAUDE_ROOM_PLAN: join(dataDir, "room-plan.json") });
  });

  it("merges per-instance FAKE_ACP_* knobs into the saved environment", () => {
    const { config, fixtureDumpPath } = verificationServerConfig(dataDir, {
      extraProviders: ["codex"],
      fakeAcp: { env: {
        claude: { FAKE_ACP_USAGE: "zero", FAKE_ACP_MODES: "default", FAKE_ACP_DUMP: join(dataDir, "claude.json") },
        codex: { FAKE_ACP_FAIL_WHEN: "boom" },
      } },
    });
    expect(instances(config).claude.environment).toEqual({ FAKE_ACP_MODES: "default", FAKE_ACP_USAGE: "zero", FAKE_ACP_DUMP: join(dataDir, "claude.json") });
    expect(instances(config).codex.environment).toEqual({ FAKE_ACP_MODES: "read-only,agent-full-access", FAKE_ACP_FAIL_WHEN: "boom" });
    expect(fixtureDumpPath).toBe(join(dataDir, "claude.json"));
  });

  it("gives each fake instance its own gate folder under the owned data folder", async () => {
    const owned = mkdtempSync(join(tmpdir(), "colonie-fixture-gates-"));
    try {
      const { config, gateDirs } = verificationServerConfig(owned, { extraProviders: ["codex"], fakeAcp: { gates: true } });
      expect(gateDirs).toEqual({ claude: join(owned, "fake-acp-gates", "claude"), codex: join(owned, "fake-acp-gates", "codex") });
      expect(instances(config).claude.environment.FAKE_ACP_GATE_DIR).toBe(gateDirs!.claude);
      expect(instances(config).codex.environment.FAKE_ACP_GATE_DIR).toBe(gateDirs!.codex);
      expect(existsSync(gateDirs!.claude!) && existsSync(gateDirs!.codex!)).toBe(true);
      const explicit = join(owned, "mine");
      expect(verificationServerConfig(owned, { fakeAcp: { gates: true, env: { claude: { FAKE_ACP_GATE_DIR: explicit } } } }).gateDirs).toEqual({ claude: explicit });
    } finally {
      await removeTempDir(owned);
    }
  });

  it("refuses anything but FAKE_ACP_* knobs, before a server is owned", async () => {
    expect(() => fakeAcpInstanceEnvironment({}, { OPENAI_API_KEY: "sk-real" })).toThrow(/FAKE_ACP_\* keys only/);
    expect(() => verificationServerConfig(dataDir, { fakeAcp: { env: { claude: { PATH: "/usr/bin" } } } })).toThrow(/FAKE_ACP_\* keys only/);
    await expect(launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, false,
      { fakeAcp: { env: { claude: { HOME: "/" } } } })).rejects.toThrow(/FAKE_ACP_\* keys only/);
    await expect(launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, false,
      { fakeAcp: { env: { codex: { FAKE_ACP_USAGE: "zero" } } } })).rejects.toThrow(/requires the codex extra provider/);
  });
});
