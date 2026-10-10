import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";

it("reports a signed-out ACP engine and signs in through the in-app authenticate", async () => {
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

    const signedIn = await api("POST", "/api/instances/codex-acp/acp-auth", {});
    expect(signedIn.status).toBe(200);
    expect(signedIn.value.instances.find((entry: any) => entry.instanceId === "codex-acp").snapshot.authenticated).toBe(true);

    const state = JSON.parse(readFileSync(join(dataDir, "acp-fixture-state.json"), "utf8"));
    expect(state.authenticated).toBe(true);
  } finally {
    await fixture.close();
  }
});