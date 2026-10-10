import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { waitForExit } from "../testing/cleanup.ts";
import type { AcpInputReceipt } from "../../shared/devone.ts";

it.each(["codex-acp", "claude-acp"])("keeps concurrent conversations on one %s bot independent through approval, Stop and restart", async (provider) => {
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
    const { bot } = await api("POST", "/api/bots", { name: "Maya", title: "Writer", modelSelection: { instanceId: provider, model: "agent-default" }, computer: "off" });
    await api("PATCH", `/api/bots/${bot.id}`, { soul: "BOT_SHARED_PROFILE_V1" });
    const a = bot.threadId;
    const { task: second } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Email" });
    const b = second.threadId;
    const current = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    const task = async (id: string) => (await current()).tasks.find((entry: any) => entry.threadId === id);
    const receipts = async (id: string): Promise<AcpInputReceipt[]> => (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${id}`)).receipts;
    const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
    const send = (id: string, text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: id, text });
    const idle = (id: string) => expect.poll(async () => (await task(id)).busy, { timeout: 15_000 }).toBe(false);
    const permission = async (id: string) => {
      await expect.poll(async () => (await messages(id)).find((row) => row.card?.requestId && !row.card.answered), { timeout: 15_000 }).toBeTruthy();
      return (await messages(id)).find((row) => row.card?.requestId && !row.card.answered)!.card.requestId as string;
    };
    await send(a, "permission alpha");
    const requestA = await permission(a);
    await api("PATCH", `/api/bots/${bot.id}`, { soul: "BOT_SHARED_PROFILE_V2" });
    await send(b, "permission beta");
    const requestB = await permission(b);
    expect((await task(a)).activity).toBe("waiting-on-you");
    expect((await task(b)).activity).toBe("waiting-on-you");
    const ra = (await receipts(a))[0]!;
    const rb = (await receipts(b))[0]!;
    expect(ra.sessionId).not.toBe(rb.sessionId);
    expect(ra.cwd).not.toBe(rb.cwd);
    expect(ra.context?.sections.find((section) => section.id === "bot.soul")?.text).toBe("BOT_SHARED_PROFILE_V1");
    expect(rb.context?.sections.find((section) => section.id === "bot.soul")?.text).toBe("BOT_SHARED_PROFILE_V2");
    await api("POST", `/api/threads/${a}/respond`, { requestId: requestB, behavior: "allow" });
    expect((await messages(b)).find((row) => row.card?.requestId === requestB)?.card.answered).not.toBe(true);
    await api("POST", `/api/threads/${a}/respond`, { requestId: requestA, behavior: "allow" });
    await idle(a);
    expect((await task(b)).busy).toBe(true);
    await api("POST", `/api/threads/${b}/respond`, { requestId: requestB, behavior: "deny" });
    await idle(b);
    expect((await messages(a)).some((row) => row.text === "Permission: yes-once")).toBe(true);
    expect((await messages(b)).some((row) => row.text === "Permission: no")).toBe(true);
    await send(a, "hang");
    await send(b, "hang");
    await expect.poll(async () => [(await receipts(a)).at(-1)?.status, (await receipts(b)).at(-1)?.status], { timeout: 15_000 }).toEqual(["dispatching", "dispatching"]);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: a });
    await idle(a);
    expect((await task(b)).busy).toBe(true);
    expect((await receipts(a)).at(-1)?.status).toBe("cancelled");
    expect((await receipts(b)).at(-1)?.status).toBe("dispatching");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: b });
    await idle(b);
    await send(a, "alpha only"); await idle(a);
    await send(b, "beta only"); await idle(b);
    expect((await messages(a)).some((row) => row.text?.includes("beta only"))).toBe(false);
    expect((await messages(b)).some((row) => row.text?.includes("alpha only"))).toBe(false);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, [join(import.meta.dirname, "../index.ts")], {
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), DEVONE_PROFILE: "1" }, stdio: ["ignore", log, log],
    }); closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).app; } catch { return null; } }, { timeout: 20_000 }).toBe("openmausbot");
    await send(a, "alpha restart"); await idle(a);
    await send(b, "beta restart"); await idle(b);
    const finalA = await receipts(a); const finalB = await receipts(b);
    expect(finalA.at(-1)?.sessionId).toBe(ra.sessionId);
    expect(finalB.at(-1)?.sessionId).toBe(rb.sessionId);
    expect(finalA.at(-1)?.context?.snapshotHash).toBe(ra.context?.snapshotHash);
    expect(finalB.at(-1)?.context?.snapshotHash).toBe(rb.context?.snapshotHash);
    expect((await task(a)).preview).toContain("alpha restart");
    expect((await task(b)).preview).toContain("beta restart");
    const nativeFile = provider === "claude-acp" ? "claude-fixture-state.json" : "acp-fixture-state.json";
    const nativeState = JSON.parse(readFileSync(join(dataDir, nativeFile), "utf8"));
    expect(nativeState.loads).toBe(2);
    expect(nativeState.sessions[ra.sessionId].prompts.join("\n")).not.toMatch(/beta only|beta restart/);
    expect(nativeState.sessions[rb.sessionId].prompts.join("\n")).not.toMatch(/alpha only|alpha restart/);
    evidence.push({ provider, finalA, finalB, nativeState });
  } finally {
    writeFileSync(`${logPath}.conversations.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidence: `${logPath}.conversations.json` }));
  }
}, 90_000);
