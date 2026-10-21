// On a Shared workspace server, each ACP engine offers sign-in from a browser
// elsewhere, through its own CLI in its own credential folder; on a desktop it
// offers nothing new (the adapter's own flow stays). A stand-in adapter plays
// the CLI and records which folder it ran in.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { ClaudeAcpDriver } from "./claude-acp.ts";
import { CodexAcpDriver } from "./codex-acp.ts";
import type { ProviderInstance } from "../contracts.ts";

const dir = mkdtempSync(join(tmpdir(), "colonie-remote-sign-in-wiring-"));
const adapter = join(dir, "adapter.mjs");
writeFileSync(adapter, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
const home = process.env.CODEX_HOME ?? process.env.CLAUDE_CONFIG_DIR;
writeFileSync(home + "/ran-with", args + "\\nBROWSER=" + process.env.BROWSER);
if (args.endsWith("login --device-auth")) {
  process.stderr.write("https://auth.openai.com/codex/device\\nWXYZ-98765\\n");
  setTimeout(() => process.exit(0), 200);
} else if (args === "--cli auth login --claudeai") {
  process.stdout.write("visit: https://claude.com/cai/oauth/authorize?state=s\\nPaste code here if prompted > ");
  process.stdin.once("data", (d) => process.exit(String(d).trim() === "ok#s" ? 0 : 1));
} else process.exit(9);
`);

const made: ProviderInstance[] = [];
const previous = process.env.COLONIE_WORKSPACE_KIND;
afterEach(async () => {
  for (const instance of made.splice(0)) await instance.dispose?.();
  if (previous === undefined) delete process.env.COLONIE_WORKSPACE_KIND; else process.env.COLONIE_WORKSPACE_KIND = previous;
});

async function codex(shared: boolean) {
  if (shared) process.env.COLONIE_WORKSPACE_KIND = "shared"; else delete process.env.COLONIE_WORKSPACE_KIND;
  const home = mkdtempSync(join(dir, "codex-home-"));
  const instance = await CodexAcpDriver.create({
    instanceId: "codex-acp", displayName: "Codex", enabled: true,
    environment: { CODEX_HOME: home }, config: CodexAcpDriver.decodeConfig({ cli: process.execPath, args: [adapter] }),
  });
  made.push(instance);
  return { instance, home };
}

test("a desktop engine offers no remote sign-in", async () => {
  const { instance } = await codex(false);
  expect(instance.startAuthentication).toBeUndefined();
});

test("Codex on a server: the code comes from its own CLI, run in its own CODEX_HOME", async () => {
  const { instance, home } = await codex(true);
  expect(instance.completeAuthentication).toBeUndefined(); // a code to enter, nothing to paste back
  const started = await instance.startAuthentication!();
  expect(started).toMatchObject({ authorizationUrl: "https://auth.openai.com/codex/device", userCode: "WXYZ-98765" });
  const ran = readFileSync(join(home, "ran-with"), "utf8");
  expect(ran).toContain('cli -c cli_auth_credentials_store="file" login --device-auth');
  expect(ran).toContain("BROWSER=true");
  const until = Date.now() + 5_000;
  while ((await instance.getAuthentication!(started.flowId!)).phase !== "succeeded") {
    if (Date.now() > until) throw new Error("never succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("Claude on a server: Anthropic's page, then the pasted code, in its own CLAUDE_CONFIG_DIR", async () => {
  process.env.COLONIE_WORKSPACE_KIND = "shared";
  const home = mkdtempSync(join(dir, "claude-home-"));
  const instance = await ClaudeAcpDriver.create({
    instanceId: "claude-acp", displayName: "Claude", enabled: true,
    environment: { CLAUDE_CONFIG_DIR: home }, config: ClaudeAcpDriver.decodeConfig({ cli: process.execPath, args: [adapter] }),
  });
  made.push(instance);
  const started = await instance.startAuthentication!();
  expect(started.authorizationUrl).toBe("https://claude.com/cai/oauth/authorize?state=s");
  expect(existsSync(join(home, "ran-with"))).toBe(true);
  await instance.completeAuthentication!(started.flowId!, "ok#s");
  expect((await instance.getAuthentication!(started.flowId!)).phase).toBe("succeeded");
});
