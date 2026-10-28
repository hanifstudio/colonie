// One step sets up a bot's computer: ready it, remember it was seen, and
// refuse while it is busy or for a bot that does not exist.
import { expect, test } from "vitest";

import { callRoute } from "../testing/route-context.ts";
import { createLocalVmSetupRoute } from "./local-vm-setup.ts";

const target = { key: "shared", containerName: "colonie-computer" } as never;
function setup(overrides: { busy?: boolean; ready?: boolean; fail?: string } = {}) {
  const seen: string[] = [];
  const route = createLocalVmSetupRoute({
    bot: (id) => id === "b1" ? { id } : undefined,
    target: () => target,
    busy: () => overrides.busy ?? false,
    ready: async () => { if (overrides.fail) throw new Error(overrides.fail); return { ready: overrides.ready ?? true } as never; },
    seen: () => { seen.push("seen"); },
  });
  return { route, seen };
}
const post = async (route: ReturnType<typeof setup>["route"], bot = "b1") => {
  const { ctx, sent } = callRoute(`/api/bots/${bot}/local-computer/setup`, "POST", {}, { "content-type": "application/json" });
  await route(ctx);
  return sent[0];
};

test("a ready computer answers its status and is remembered", async () => {
  const { route, seen } = setup();
  expect(await post(route)).toEqual({ status: 200, body: { ready: true } });
  expect(seen).toEqual(["seen"]);
});

test("busy, unknown bot, or a failed start answer plainly", async () => {
  expect((await post(setup({ busy: true }).route))?.status).toBe(409);
  expect((await post(setup().route, "nope"))?.status).toBe(404);
  expect(await post(setup({ fail: "docker did not start" }).route)).toEqual({ status: 409, body: { error: "docker did not start" } });
});
