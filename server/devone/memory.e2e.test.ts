import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { waitForExit } from "../testing/cleanup.ts";
import type { AcpInputReceipt } from "../../shared/devone.ts";
import type { MemoryView } from "../../shared/colonie-memory.ts";

it.each(["codex-acp", "claude-acp"])("captures, corrects, scopes, forgets and resumes memory through the real SDK/HTTP boundary for %s", async (provider) => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"]);
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
    const create = async (name: string) => (await api("POST", "/api/bots", { name, computer: "off", modelSelection: { instanceId: provider, model: "agent-default" } })).bot;
    const a = await create("Memory Alpha");
    const b = await create("Memory Beta");
    const view = (bot = a): Promise<MemoryView> => api("GET", `/api/bots/${bot.id}/colonie-memory`);
    const receipts = async (bot = a, threadId = bot.threadId): Promise<AcpInputReceipt[]> => (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${threadId}`)).receipts;
    const send = async (bot: any, text: string, threadId = bot.threadId) => {
      const count = (await receipts(bot, threadId)).length;
      await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId });
      await expect.poll(async () => {
        const rows = await receipts(bot, threadId);
        return rows.length === count + 1 && rows.at(-1)?.status === "completed";
      }, { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => { const state = await view(bot); return !state.status.running && state.status.pending === 0; }, { timeout: 20_000 }).toBe(true);
      return (await receipts(bot, threadId)).at(-1)!;
    };
    const initialView = await view();
    expect(initialView.app).toEqual({ enabled: true, automatic: true });
    expect(initialView.bot).toEqual({ enabled: true, automatic: true });
    const first = await send(a, "I prefer concise replies. Project Nebula launches on October 20.");
    await expect.poll(async () => (await view()).entries.length, { timeout: 20_000 }).toBe(2);
    const captured = await view();
    const shared = captured.entries.find((entry) => entry.scope === "shared")!;
    const privateFact = captured.entries.find((entry) => entry.scope === "bot")!;
    expect(shared.text).toBe("The user prefers concise replies.");
    expect(shared.source?.quote).toBe("I prefer concise replies.");
    expect(privateFact.botId).toBe(a.id);
    expect((await view(b)).entries.map((entry) => entry.id)).toEqual([shared.id]);
    const task = (await api("POST", `/api/bots/${a.id}/tasks`, {})).task;
    const recalled = await send(a, "How should you answer me about Project Nebula?", task.threadId);
    expect(recalled.sessionId).not.toBe(first.sessionId);
    const section = recalled.context?.sections.find((entry) => entry.id === "memory.recall");
    expect(section?.text).toContain("concise replies");
    expect(section?.text).toContain("Project Nebula");
    expect(recalled.prompt.at(-1)).toEqual({ type: "text", text: "How should you answer me about Project Nebula?" });
    const beta = await send(b, "How should you answer me about Project Nebula?");
    expect(beta.context?.sections.find((entry) => entry.id === "memory.recall")?.text).toContain("concise replies");
    expect(beta.prompt.map((entry) => entry.type === "text" ? entry.text : "").join("\n")).not.toContain("launches on October 20");
    await send(a, "I now prefer detailed replies.");
    await expect.poll(async () => (await view()).entries.find((entry) => entry.id === shared.id)?.text, { timeout: 20_000 }).toBe("The user prefers detailed replies.");
    const corrected = await view();
    expect(corrected.entries.filter((entry) => entry.key === "user.reply-style")).toHaveLength(1);
    expect(corrected.entries.find((entry) => entry.id === shared.id)?.source?.quote).toBe("I now prefer detailed replies.");
    const stale = await fetch(`${url}/api/bots/${a.id}/colonie-memory/entries/${shared.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ text: "Stale edit", expectedRevision: captured.revision }),
    });
    expect(stale.status).toBe(409);
    await send(a, "Forget my reply style.");
    await expect.poll(async () => (await view()).entries.some((entry) => entry.id === shared.id), { timeout: 20_000 }).toBe(false);
    await send(a, "I prefer concise replies.");
    expect((await view()).entries.some((entry) => entry.key === "user.reply-style")).toBe(false);
    const beforeOff = await view();
    await api("PATCH", `/api/bots/${a.id}/colonie-memory/preferences`, {
      scope: "bot", preferences: { enabled: false, automatic: true }, expectedRevision: beforeOff.revision,
    });
    const off = await send(a, "Project Nebula launches on October 20.", task.threadId);
    expect(off.context?.sections.some((entry) => entry.id === "memory.recall")).toBe(false);
    expect((await view()).entries.some((entry) => entry.id === privateFact.id)).toBe(true);
    const state = await view();
    await api("PATCH", `/api/bots/${a.id}/colonie-memory/preferences`, {
      scope: "bot", preferences: { enabled: true, automatic: false }, expectedRevision: state.revision,
    });
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, [join(import.meta.dirname, "../index.ts")], {
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), DEVONE_PROFILE: "1" }, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).app; } catch { return null; } }, { timeout: 20_000 }).toBe("colonie");
    const resumed = await send(a, "When does Project Nebula launch?", task.threadId);
    expect(resumed.sessionId).toBe(recalled.sessionId);
    expect(resumed.context?.snapshotHash).toBe(recalled.context?.snapshotHash);
    expect(resumed.context?.sections.find((entry) => entry.id === "memory.recall")?.text).toContain("October 20");
    expect((await view()).bot).toEqual({ enabled: true, automatic: false });
    const nativeFile = provider === "claude-acp" ? "claude-fixture-state.json" : "acp-fixture-state.json";
    const nativeState = JSON.parse(readFileSync(join(dataDir, nativeFile), "utf8"));
    expect(nativeState.sessions[recalled.sessionId].prompts).toHaveLength(3);
    evidence.push({ provider, first, captured, recalled, beta, corrected, off, resumed, memory: await view() });
  } finally {
    writeFileSync(`${logPath}.colonie-memory.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidence: `${logPath}.colonie-memory.json` }));
  }
}, 120_000);
