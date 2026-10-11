import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../../scripts/control-omb.ts";
import { waitForExit } from "../../testing/cleanup.ts";
import type { AcpInputReceipt } from "../../../shared/devone.ts";
import type { ChiefView } from "../../../shared/colonie-chief.ts";

it.each(["codex-acp", "claude-acp"])(
  "keeps one default Chief, transfers the role, and delivers an enabled guide index through the real ACP SDK for %s",
  async (provider) => {
    const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"]);
    const { url, logPath } = fixture.info;
    const evidence: unknown[] = [fixture.info];
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value as any;
    };
    const receipts = async (botId: string, threadId: string): Promise<AcpInputReceipt[]> =>
      (await api("GET", `/api/bots/${botId}/acp-inputs?threadId=${threadId}`)).receipts;
    const send = async (bot: any, text: string, threadId = bot.threadId) => {
      const before = (await receipts(bot.id, threadId)).length;
      await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId });
      await expect.poll(async () => {
        const rows = await receipts(bot.id, threadId);
        return rows.length === before + 1 && rows.at(-1)?.status === "completed";
      }, { timeout: 30_000 }).toBe(true);
      return (await receipts(bot.id, threadId)).at(-1)!;
    };
    try {
      // The seeded first bot is the workspace Chief by default.
      const bots = (await api("GET", "/api/bots")).bots;
      const first = bots[0];
      expect(first.chiefOfStaff).toBe(true);
      expect(bots.filter((bot: any) => bot.chiefOfStaff)).toHaveLength(1);

      // A second bot is created, made Chief, and the role is transferred (not duplicated).
      const second = (await api("POST", "/api/bots", { name: "Assistant", computer: "off",
        modelSelection: { instanceId: provider, model: "agent-default" } })).bot;
      const view = async (): Promise<ChiefView> => api("GET", "/api/colonie/chief");
      const before = await view();
      expect(before.chief?.id).toBe(first.id);
      const afterView: ChiefView = await api("PUT", "/api/colonie/chief", { botId: second.id, expectedRevision: before.revision });
      expect(afterView.chief?.id).toBe(second.id);
      const botsAfter = (await api("GET", "/api/bots")).bots;
      expect(botsAfter.filter((bot: any) => bot.chiefOfStaff)).toHaveLength(1);
      expect(botsAfter.find((bot: any) => bot.id === first.id)?.chiefOfStaff).toBeFalsy();

      // A stale transfer reuses an old revision and is refused.
      const stale = await fetch(`${url}/api/colonie/chief`, { method: "PUT",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ botId: first.id, expectedRevision: before.revision }) });
      expect(stale.status).toBe(409);

      // A guide authored through the normal owner API reaches a real ACP turn's
      // receipt as a bounded index, and the scoped workspace MCP is mounted.
      const initialSkills = await api("GET", `/api/bots/${second.id}/colonie-skills`);
      const guide = await api("POST", `/api/bots/${second.id}/colonie-skills`, {
        skill: { name: "proposal-style", description: "Use when drafting a client proposal.", instructions: "Always open with a one-line summary.", enabled: true },
        expectedRevision: initialSkills.revision,
      });
      expect(guide.skills.some((skill: any) => skill.name === "proposal-style" && skill.enabled)).toBe(true);
      const fresh = (await api("POST", `/api/bots/${second.id}/tasks`, {})).task;
      const receipt = await send({ id: second.id, threadId: fresh.threadId }, "Please draft a client proposal.");
      const index = receipt.context?.sections.find((section) => section.id === "skills.index");
      expect(index?.text).toContain("proposal-style");
      expect(index?.source).toContain("proposal-style");
      expect(receipt.connectedTools?.servers.some((server: any) => server.name === "colonie_workspace")).toBe(true);

      // Disabled guides are excluded from a new dispatch's index.
      const current = (await view()).chief!;
      const listing = await api("GET", `/api/bots/${second.id}/colonie-skills`);
      await api("PATCH", `/api/bots/${second.id}/colonie-skills/proposal-style`, {
        enabled: false, expectedRevision: listing.revision,
      });
      const fresh2 = (await api("POST", `/api/bots/${second.id}/tasks`, {})).task;
      const receipt2 = await send({ id: second.id, threadId: fresh2.threadId }, "Draft another proposal please.");
      const index2 = receipt2.context?.sections.find((section) => section.id === "skills.index");
      expect(index2?.text ?? "").not.toContain("proposal-style");
      expect(current.id).toBe(second.id);

      // A real delegated task: the Chief (second) asks a Worker bot through the
      // colonie_workspace MCP tool. The fixture requests permission for the tool
      // call; we allow it, the child runs in its own conversation, and its result
      // returns to the Chief's turn.
      const worker = (await api("POST", "/api/bots", { name: "Worker", computer: "off",
        modelSelection: { instanceId: provider, model: "agent-default" } })).bot;
      const bossThread = (await api("POST", `/api/bots/${second.id}/tasks`, {})).task.threadId;
      const workerTasks = async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === worker.id)?.tasks.length ?? 0;
      const allowPermission = async (threadId: string) => {
        await expect.poll(async () => {
          const messages = (await api("GET", `/api/threads/${threadId}/messages`)).messages as any[];
          const card = messages.find((message) => message.card?.requestId && !message.card.answered);
          if (!card) return false;
          await api("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
          return true;
        }, { timeout: 30_000 }).toBe(true);
      };
      const askCommand = `mcp call colonie_workspace ask_bot ${JSON.stringify({
        targetBotId: worker.id, message: "Reply with the exact word PONG.", requestId: "ask-1",
      })}`;

      const workerBefore = await workerTasks();
      const bossBefore = (await receipts(second.id, bossThread)).length;
      await api("POST", `/api/bots/${second.id}/messages`, { text: askCommand, threadId: bossThread });
      await allowPermission(bossThread);
      await expect.poll(async () => {
        const rows = await receipts(second.id, bossThread);
        return rows.length === bossBefore + 1 && rows.at(-1)?.status === "completed";
      }, { timeout: 120_000 }).toBe(true);
      const askReceipt = (await receipts(second.id, bossThread)).at(-1)!;
      expect(askReceipt.connectedToolCalls?.some((call: any) => call.tool === "ask_bot" && call.status === "completed")).toBe(true);
      const workerAfter = await workerTasks();
      expect(workerAfter).toBe(workerBefore + 1);
      const askedView = await view();
      const assignment = askedView.assignments.find((item: any) => item.targetBotId === worker.id);
      expect(assignment?.status).toBe("completed");
      expect(assignment?.result ?? "").toContain("PONG");

      // The same requestId is idempotent: the Chief replays the recorded result
      // instead of delegating the same task a second time.
      const bossBefore2 = (await receipts(second.id, bossThread)).length;
      await api("POST", `/api/bots/${second.id}/messages`, { text: askCommand, threadId: bossThread });
      await allowPermission(bossThread);
      await expect.poll(async () => {
        const rows = await receipts(second.id, bossThread);
        return rows.length === bossBefore2 + 1 && rows.at(-1)?.status === "completed";
      }, { timeout: 120_000 }).toBe(true);
      expect(await workerTasks()).toBe(workerAfter);

      evidence.push({ provider, firstId: first.id, secondId: second.id, before, afterView, receipt, receipt2,
        askReceipt, askAssignment: assignment, workerBefore, workerAfter });
    } finally {
      writeFileSync(`${logPath}.chief-skills.json`, JSON.stringify(evidence, null, 2));
      await waitForExit(fixture.child, { signal: "SIGTERM" });
      await fixture.close();
      console.info(JSON.stringify({ logPath, evidence: `${logPath}.chief-skills.json` }));
    }
  },
  120_000,
);