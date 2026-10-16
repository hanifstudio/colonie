import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../../scripts/control-colonie.ts";
import { waitForExit } from "../testing/cleanup.ts";
import type { AcpInputReceipt } from "../../shared/acp.ts";

it.each(["codex-acp", "claude-acp"])("runs the real HTTP/SSE application over %s with transparent context, approvals and queueing", async (provider) => {
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
    // Every registered instance is a maintained ACP adapter: the shared
    // fixture also configures its own `claude` engine, and nothing else.
    const kinds = (await api("GET", "/api/instances")).instances.map((entry: any) => entry.driverKind);
    expect(kinds).toEqual(expect.arrayContaining(["codex-acp", "claude-acp"]));
    expect(new Set(kinds)).toEqual(new Set(["codex-acp", "claude-acp"]));
    const { bot } = await api("POST", "/api/bots", { name: "ACP fixture", title: "UNWANTED ROLE", description: "UNWANTED PERSONALITY",
      soul: "UNWANTED SOUL", modelSelection: { instanceId: provider, model: "agent-default" }, computer: "off" });
    const defaults = await api("GET", `/api/bots/${bot.id}/acp-context?threadId=${bot.threadId}`);
    await api("PATCH", `/api/bots/${bot.id}/acp-context`, { threadId: bot.threadId, scope: "app", expectedRevision: defaults.app.revision, preferences: { enabled: false, instructions: "" } });
    await api("PATCH", `/api/bots/${bot.id}/acp-context`, { threadId: bot.threadId, scope: "bot", expectedRevision: defaults.bot.revision, preferences: { persona: false, soul: false } });
    const send = (text: string) => api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
    const wait = async () => {
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)?.busy, { timeout: 15_000 }).toBe(false);
      const rows = await messages();
      evidence.push(rows);
      return rows;
    };
    const settingsPath = `/api/bots/${bot.id}/acp-settings`;
    let controls = await api("POST", settingsPath, { threadId: bot.threadId });
    expect(controls.options.map((option: any) => option.id)).toEqual(["model", "effort", "fast"]);
    expect((await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts).toEqual([]);
    controls = await api("PATCH", settingsPath, { threadId: bot.threadId, sessionId: controls.sessionId, expectedRevision: controls.revision, kind: "option", configId: "effort", value: "high" });
    const previous = controls;
    controls = await api("PATCH", settingsPath, { threadId: bot.threadId, sessionId: controls.sessionId, expectedRevision: controls.revision, kind: "option", configId: "model", value: "fixture-alt" });
    expect(controls.options.find((option: any) => option.id === "model").currentValue).toBe("fixture-alt");
    const stale = await fetch(`${url}${settingsPath}`, { method: "PATCH", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ threadId: bot.threadId, sessionId: previous.sessionId, expectedRevision: previous.revision, kind: "mode", value: "plan" }) });
    expect(stale.status).toBe(409);
    const foreign = await fetch(`${url}${settingsPath}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ threadId: "not-owned" }) });
    expect(foreign.status).toBe(404);
    controls = await api("PATCH", settingsPath, { threadId: bot.threadId, sessionId: controls.sessionId, expectedRevision: controls.revision, kind: "option", configId: "effort", value: "low" });
    const taskPath = `/api/bots/${bot.id}/tasks/${bot.threadId}`;
    const otherProvider = provider === "codex-acp" ? "claude-acp" : "codex-acp";
    await api("PATCH", taskPath, { modelSelection: { instanceId: otherProvider, model: "agent-default" } });
    const otherPreview = await api("POST", settingsPath, { threadId: bot.threadId });
    expect(otherPreview.instanceId).toBe(otherProvider);
    await api("PATCH", taskPath, { modelSelection: { instanceId: provider, model: "fixture-alt" } });
    await send("literal input\nsecond line");
    expect((await wait()).some((entry) => entry.text === "1: literal input\nsecond line")).toBe(true);
    const first = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts as AcpInputReceipt[];
    expect(first[0]!.prompt).toEqual([{ type: "text", text: "literal input\nsecond line" }]);
    expect(first[0]!.instructions).toBe("");
    expect(first[0]!.nativeSettings).toMatchObject({ model: "fixture-alt", effort: "low" });
    expect((await api("GET", `/api/bots/${bot.id}/system-prompt`)).sections).toEqual([]);
    await api("PATCH", taskPath, { modelSelection: { instanceId: otherProvider, model: "agent-default" } });
    const crossProvider = await fetch(`${url}${settingsPath}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ threadId: bot.threadId }) });
    expect(crossProvider.status).toBe(409);
    const wrongHistory = await fetch(`${url}/api/bots/${bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ threadId: bot.threadId, text: "must not use a preview as history" }) });
    expect(wrongHistory.status).toBe(409);
    await api("PATCH", taskPath, { modelSelection: { instanceId: provider, model: "fixture-alt" } });
    await send("continue");
    expect((await wait()).some((entry) => entry.text === "2: continue")).toBe(true);
    const second = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts as AcpInputReceipt[];
    expect(second[1]!.sessionId).toBe(first[0]!.sessionId);
    await send("permission");
    await expect.poll(async () => (await messages()).find((entry) => entry.card?.requestId && !entry.card.answered), { timeout: 15_000 }).toBeTruthy();
    const request = (await messages()).find((entry) => entry.card?.requestId && !entry.card.answered)!;
    const busySettings = await fetch(`${url}${settingsPath}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ threadId: bot.threadId }) });
    expect(busySettings.status).toBe(409);
    const queued = await send("queued follow-up");
    expect(queued.queued).toBe(true);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: request.card.requestId, behavior: "allow" });
    await expect.poll(async () => (await messages()).some((entry) => entry.text === "4: queued follow-up"), { timeout: 15_000 }).toBe(true);
    expect((await wait()).some((entry) => entry.text === "Permission: yes-once")).toBe(true);
    const nativeStateFile = provider === "claude-acp" ? "claude-fixture-state.json" : "acp-fixture-state.json";
    expect(JSON.parse(readFileSync(join(dataDir, nativeStateFile), "utf8")).permissions).toEqual(["yes-once"]);
    evidence.push({ receipts: (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts });
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, [join(import.meta.dirname, "../index.ts")], {
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), COLONIE_PROFILE: "1" },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).app; } catch { return null; } }, { timeout: 20_000 }).toBe("colonie");
    await send("after application restart");
    expect((await wait()).some((entry) => entry.text === "5: after application restart")).toBe(true);
    const receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts as AcpInputReceipt[];
    expect(receipts.at(-1)!.sessionId).toBe(first[0]!.sessionId);
    expect(JSON.parse(readFileSync(join(dataDir, nativeStateFile), "utf8")).loads).toBe(1);
    evidence.push({ restarted: true, receipts });
  } finally {
    writeFileSync(`${logPath}.colonie-dev.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidence: `${logPath}.colonie-dev.json` }));
  }
}, 60_000);
