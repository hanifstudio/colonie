import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../../scripts/control-colonie.ts";
import { waitForExit } from "../testing/cleanup.ts";
import type { AcpInputReceipt } from "../../shared/acp.ts";
import type { AcpContextView } from "../../shared/acp-context.ts";

it.each(["codex-acp", "claude-acp"])("isolates app/bot context and pins it across discovery, edits and restart for %s", async (provider) => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["colonie"]);
  const { url, dataDir, logPath } = fixture.info;
  const evidence: unknown[] = [fixture.info];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value as any;
  };
  try {
    await api("PATCH", "/api/config", { profile: { aboutMe: "EXCLUDED_ABOUT_ME" } });
    const create = async (name: string) => {
      const { bot } = await api("POST", "/api/bots", { name, title: `${name}_ROLE`, description: `${name}_PERSONA`,
        modelSelection: { instanceId: provider, model: "agent-default" }, computer: "off" });
      await api("PATCH", `/api/bots/${bot.id}`, { soul: `${name}_SOUL_V1`, memoryEnabled: true });
      return bot;
    };
    const a = await create("ALPHA");
    const b = await create("BETA");
    const plain = await create("PLAIN");
    const automatic = await create("AUTOMATIC");
    const view = (bot: any, threadId = bot.threadId): Promise<AcpContextView> => api("GET", `/api/bots/${bot.id}/acp-context?threadId=${threadId}`);
    const configure = async (bot: any, scope: "app" | "bot", preferences: unknown) => {
      const current = await view(bot);
      return api("PATCH", `/api/bots/${bot.id}/acp-context`, { threadId: bot.threadId, scope, preferences, expectedRevision: current[scope].revision });
    };
    const receipts = async (bot: any, threadId = bot.threadId): Promise<AcpInputReceipt[]> => (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${threadId}`)).receipts;
    const send = async (bot: any, text: string, threadId = bot.threadId) => {
      const previousCount = (await receipts(bot, threadId)).length;
      await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId });
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)?.tasks.find((task: any) => task.threadId === threadId)?.busy, { timeout: 15_000 }).toBe(false);
      const rows = await receipts(bot, threadId);
      expect(rows).toHaveLength(previousCount + 1);
      expect(rows.at(-1)?.status).toBe("completed");
      return rows.at(-1)!;
    };
    const defaults = await view(automatic);
    expect(defaults.app.enabled).toBe(true);
    expect(defaults.bot).toMatchObject({ persona: true, soul: true });
    const autoReceipt = await send(automatic, "use the saved profile automatically");
    expect(autoReceipt.context?.sections.find((section) => section.id === "app.identity")?.status).toBe("active");
    expect(autoReceipt.context?.sections.find((section) => section.id === "bot.persona")?.text).toContain("AUTOMATIC_ROLE");
    expect(autoReceipt.context?.sections.find((section) => section.id === "bot.soul")?.text).toBe("AUTOMATIC_SOUL_V1");
    await configure(plain, "app", { enabled: false, instructions: "" });
    await configure(plain, "bot", { persona: false, soul: false });
    const plainReceipt = await send(plain, "plain bytes\nunchanged");
    expect(plainReceipt.prompt).toEqual([{ type: "text", text: "plain bytes\nunchanged" }]);
    // Simulate a pre-M7-B conversation by removing only this fixture's plain pin.
    unlinkSync(join(dataDir, "acp-context", "threads", `${plain.threadId}.json`));
    const plainFile = join(dataDir, "acp-inputs", `${plain.threadId}.json`);
    const oldReceipts = await receipts(plain);
    for (const receipt of oldReceipts) delete receipt.context;
    writeFileSync(plainFile, JSON.stringify(oldReceipts));
    const staleRevision = (await view(a)).app.revision;
    await configure(a, "app", { enabled: true, instructions: "APP_SHARED_V1" });
    const stale = await fetch(`${url}/api/bots/${a.id}/acp-context`, { method: "PATCH", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ threadId: a.threadId, scope: "app", expectedRevision: staleRevision, preferences: { enabled: false, instructions: "" } }) });
    expect(stale.status).toBe(409);
    const foreign = await fetch(`${url}/api/bots/${a.id}/acp-context?threadId=${b.threadId}`);
    expect(foreign.status).toBe(404);
    await configure(a, "bot", { persona: true, soul: true });
    await configure(b, "bot", { persona: false, soul: true });
    const native = await api("POST", `/api/bots/${a.id}/acp-settings`, { threadId: a.threadId });
    expect((await view(a)).pinned).toBeNull();
    expect(await receipts(a)).toEqual([]);
    await api("PATCH", `/api/bots/${a.id}`, { soul: "ALPHA_SOUL_AFTER_DISCOVERY" });
    const first = await send(a, "literal user text\nsecond line");
    expect(first.sessionId).toBe(native.sessionId);
    const authored = first.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    expect(authored).toContain("APP_SHARED_V1");
    expect(authored).toContain("ALPHA_PERSONA");
    expect(authored).toContain("ALPHA_SOUL_AFTER_DISCOVERY");
    expect(authored).not.toMatch(/BETA_|EXCLUDED_ABOUT_ME|ALPHA_SOUL_V1/);
    expect(first.prompt.at(-1)).toEqual({ type: "text", text: "literal user text\nsecond line" });
    expect(first.context?.sections.find((section) => section.id === "bot.soul")).toMatchObject({ scope: "bot", source: `bot:${a.id}:soul`, status: "active" });
    expect(first.context?.sections.find((section) => section.id === "app.instructions")).toMatchObject({ scope: "app", source: "Workspace owner", status: "active" });
    await api("PATCH", `/api/bots/${a.id}`, { description: "ALPHA_PERSONA_V2", soul: "ALPHA_SOUL_V2" });
    await configure(a, "app", { enabled: true, instructions: "APP_SHARED_V2" });
    expect((await view(a)).changed).toBe(true);
    const beta = await send(b, "beta task");
    const betaText = beta.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    expect(betaText).toContain("APP_SHARED_V2");
    expect(betaText).toContain("BETA_SOUL_V1");
    expect(betaText).not.toMatch(/ALPHA_|BETA_PERSONA/);
    expect((await view(b)).bot).toMatchObject({ persona: false, soul: true });
    const currentNative = await api("POST", `/api/bots/${a.id}/acp-settings`, { threadId: a.threadId });
    await api("PATCH", `/api/bots/${a.id}/acp-settings`, { threadId: a.threadId, sessionId: currentNative.sessionId, expectedRevision: currentNative.revision, kind: "mode", value: "plan" });
    const continued = await send(a, "continue with pinned profile");
    expect(continued.context?.snapshotHash).toBe(first.context?.snapshotHash);
    expect(continued.context?.sections.find((section) => section.id === "bot.soul")?.text).toBe("ALPHA_SOUL_AFTER_DISCOVERY");
    expect(continued.context?.sections.find((section) => section.id === "app.instructions")?.text).toBe("APP_SHARED_V1");
    expect(continued.context?.sections.find((section) => section.id === "app.capabilities")?.text).toContain("Native mode: plan");
    expect(continued.sessionId).toBe(first.sessionId);
    const legacy = await send(plain, "legacy stays plain");
    expect(legacy.prompt).toEqual([{ type: "text", text: "legacy stays plain" }]);
    expect((await view(plain)).pinned?.legacyPlain).toBe(true);
    expect((await view(plain)).changed).toBe(false);
    const { task: newTask } = await api("POST", `/api/bots/${a.id}/tasks`, {});
    const fresh = await send(a, "new conversation", newTask.threadId);
    expect(fresh.context?.sections.find((section) => section.id === "bot.soul")?.text).toBe("ALPHA_SOUL_V2");
    expect(fresh.context?.sections.find((section) => section.id === "app.instructions")?.text).toBe("APP_SHARED_V2");
    expect(fresh.context?.snapshotHash).not.toBe(first.context?.snapshotHash);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, [join(import.meta.dirname, "../index.ts")], {
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), COLONIE_PROFILE: "1" }, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).app; } catch { return null; } }, { timeout: 20_000 }).toBe("colonie");
    const resumed = await send(a, "after full server restart", a.threadId);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.context?.snapshotHash).toBe(first.context?.snapshotHash);
    expect(resumed.context?.sections.find((section) => section.id === "bot.soul")?.text).toBe("ALPHA_SOUL_AFTER_DISCOVERY");
    const nativeFile = provider === "claude-acp" ? "claude-fixture-state.json" : "acp-fixture-state.json";
    const nativeState = JSON.parse(readFileSync(join(dataDir, nativeFile), "utf8"));
    expect(nativeState.sessions[first.sessionId].prompts[0]).toBe(authored);
    expect(nativeState.sessions[first.sessionId].prompts).toHaveLength(3);
    evidence.push({ provider, defaults, autoReceipt, first, beta, continued, legacy, fresh, resumed, nativeState });
  } finally {
    writeFileSync(`${logPath}.context.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidence: `${logPath}.context.json` }));
  }
}, 90_000);
