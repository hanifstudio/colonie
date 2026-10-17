// The monthly spend cap and sell prices through real turns: the isolated
// scripted ACP fixture booted with a stand-in enterprise layer that grants
// `budgets` and `billing`, the shared control surface for sends and waits,
// and the cap read back from /api/usage. ACP adapters report tokens but no
// cost, so every turn here is priced as an estimate from the operator's list.
// No real licence, engine, or provider is involved; the fixture's home is
// disposable.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlColonie, type VerificationServer } from "../scripts/control-colonie.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

describe("spend cap and prices through real turns", () => {
  let session: VerificationServer;
  let layerDir: string;

  beforeEach(async () => {
    // The folder shape core looks for: <dir>/server/index.js exporting register().
    layerDir = mkdtempSync(join(tmpdir(), "colonie-fake-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets", "billing"], expiresAt: "2099-01-01" }; }\n');
    // Ten input and five output tokens per turn, stated rather than inherited
    // from the fake's default.
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" },
      undefined, [], undefined, undefined, false, { fakeAcp: { env: { claude: { FAKE_ACP_USAGE: JSON.stringify({ inputTokens: 10, outputTokens: 5 }) } } } });
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
    await removeTempDir(layerDir);
  });

  const control = (args: string[]) => runControlColonie([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const put = (body: unknown) => api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = (botId: string, text: string) => api(`/api/bots/${encodeURIComponent(botId)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });

  it("refuses the next turn once the month reaches the cap, prices turns, and lets a raised cap through", async () => {
    const edition = (await (await api("/api/edition")).json()) as { edition: string; features: string[] };
    expect(edition).toMatchObject({ edition: "enterprise", features: ["billing", "budgets"] });

    const created = await control(["new-bot", "--name", "Cap probe"]);
    const botId = created.bot.id as string;
    // 10 × $400/M + 5 × $1,200/M = $0.01 per turn, estimated from the
    // operator's price for this exact model (it wins over the built-in list):
    // a $0.015 cap allows two turns and refuses the third.
    const rate = { inputPerMillion: 400, outputPerMillion: 1200 };
    const model = created.bot.modelSelection?.model as string | undefined;
    const prices = { ...(model ? { [model]: rate } : {}), default: rate };
    expect((await put({ budgets: { monthlyUsd: 0.015, warnAtPercent: 50 }, billing: { currency: "USD", prices } })).status).toBe(200);

    // The owner hears about the warning and the cap once each.
    const adminStream = await openSse(`${session.info.url}/api/events`);
    const spendNotices = (frames: any[]) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === "spend");

    try {
      for (const text of ["first", "second"]) {
        expect((await send(botId, text)).status).toBeLessThan(300);
        expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
      }
      // $0.01 of $0.015 crosses the 50% warning; $0.02 reaches the cap
      await adminStream.until((frame) => frame.kind === "notify" && frame.notification?.title === "Monthly spend limit reached", 20_000);
      expect(spendNotices(adminStream.frames).map((frame) => frame.notification)).toEqual([
        expect.objectContaining({ kind: "spend", botId, title: "Spend is at 67% of the monthly limit", body: expect.stringContaining("$0.01 of $0.015 spent this month") }),
        expect.objectContaining({ kind: "spend", botId, title: "Monthly spend limit reached" }),
      ]);
    } finally {
      adminStream.close();
    }
    const refused = await send(botId, "third");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "spend_cap", error: expect.stringContaining("$0.015") });

    const usage = (await (await api("/api/usage?groupBy=bot")).json()) as any;
    expect(usage.budget).toMatchObject({ monthlyUsd: 0.015, exceeded: true, warn: true });
    expect(usage.budget.spentUsd).toBeCloseTo(0.02, 6);
    expect(usage.billing).toEqual({ currency: "USD" });
    expect(usage.groups).toHaveLength(1);
    expect(usage.groups[0].turns).toBe(2);
    expect(usage.total).toMatchObject({ input: 20, output: 10, unpriced: 0 });
    // the cap counted estimates, and the bill is priced from the same list
    expect(usage.total.estimatedUsd).toBeCloseTo(0.02, 9);
    expect(usage.total.billableUsd).toBeCloseTo(0.02, 9);
    expect(usage.groups[0].billableUsd).toBeCloseTo(0.02, 9);
    const csv = await (await api("/api/usage.csv")).text();
    expect(csv.split("\n")[0]).toContain("billable_usd");

    // A raised cap lets the same owner send again.
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    expect((await send(botId, "fourth")).status).toBeLessThan(300);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
    const raised = (await (await api("/api/usage")).json()) as any;
    expect(raised.budget).toMatchObject({ monthlyUsd: 1, exceeded: false });
    expect(raised.total.turns).toBe(3);
  }, 150_000);
});
