import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";

it("reports a signed-out ACP engine and hands the terminal sign-in command", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone-unauth"]);
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, value: await response.json() as any };
  };
  try {
    const before = (await api("GET", "/api/instances")).value.instances as any[];
    expect(before.find((entry) => entry.instanceId === "codex-acp").snapshot.authenticated).toBe(false);
    expect(before.find((entry) => entry.instanceId === "claude-acp").snapshot.authenticated).toBe(false);

    // No engine can run yet: never hand a new bot an empty model selection.
    const defaults = (await api("GET", "/api/bot-defaults")).value;
    expect(defaults.modelSelection.instanceId).toBe("");
    expect(defaults.modelSelection.model).toBe("");

    // Sign-in is the engine's own CLI in a terminal, with the isolated dir.
    const auth = await api("POST", "/api/instances/codex-acp/acp-auth", {});
    expect(auth.status).toBe(200);
    expect(auth.value.terminal.command).toContain(join(dataDir, "native", "codex"));
    expect(auth.value.terminal.command).toContain("codex login");
  } finally {
    await fixture.close();
  }
});

it("fills an ACP engine's model list before the first message", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"]);
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, value: await response.json() as any };
  };
  const official = (instances: any[]) => instances.find((entry) => entry.instanceId === "claude-acp").models.options.filter((option: any) => !option.custom);
  try {
    expect(official((await api("GET", "/api/instances")).value.instances).length).toBe(1);
    expect((await api("POST", "/api/instances/claude-acp/refresh-models", {})).status).toBe(200);
    const after = official((await api("GET", "/api/instances")).value.instances);
    expect(after.length).toBeGreaterThan(1);
    expect(after.some((option: any) => option.id === "fixture")).toBe(true);
  } finally {
    await fixture.close();
  }
});