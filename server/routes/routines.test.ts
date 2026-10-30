import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createRoutineRoutes, type RoutineRouteDeps } from "./routines.ts";

const visibleOnly = (...ids: string[]) =>
  ({ everything: false, bot: (id: string) => ids.includes(id), group: (id: string) => ids.includes(id), thread: (id: string) => ids.includes(id) }) as never;

const calls: string[] = [];

const routes = (over: Partial<RoutineRouteDeps> = {}) =>
  createRoutineRoutes({
    routines: {
      listRoutines: () => [
        { id: "mine", botId: "alpha" },
        { id: "theirs", botId: "hidden" },
      ],
      listRuns: (from?: number, to?: number) => {
        calls.push(`listRuns:${String(from)}:${String(to)}`);
        return [
          { id: "run-mine", botId: "alpha" },
          { id: "run-theirs", groupId: "hidden-room" },
        ];
      },
      create: (body: unknown) => ({ id: "new", ...(body as object) }),
      update: (id: string, body: unknown) => (id === "mine" ? { id, ...(body as object) } : null),
      remove: (id: string) => id === "mine",
      runNow: (id: string) => (id === "mine" ? { id: "run-new", routineId: id } : null),
      cancelRun: async (id: string) => (id === "run-mine" ? { id, status: "cancelled" } : null),
      markSeen: (id: string) => (id === "run-mine" ? { id, seen: true } : null),
      markAllSeen: () => [{ id: "run-mine", seen: true }],
      wakeHold: () => ({ hold: false, next: null }),
    } as never,
    store: { bot: (id: string) => (id === "alpha" || id === "hidden" ? { id } : undefined), group: (id: string) => (id === "room" || id === "hidden-room" ? { id } : undefined) } as never,
    visibleFor: () => visibleOnly("alpha", "room"),
    ...over,
  });

const call = async (handler: ReturnType<typeof createRoutineRoutes>, path: string, method = "GET", body: unknown = {}) => {
  const { ctx, sent } = callRoute(path, method, body);
  const out = await handler(ctx);
  return { out, sent };
};

test("a request that is not its own is left to the next handler", async () => {
  const { out, sent } = await call(routes(), "/api/health");

  expect(out).toBe(PASS);
  expect(sent).toEqual([]);
});

test("a listing never shows a hidden bot's routine or run", async () => {
  const { sent } = await call(routes(), "/api/routines");

  const body = sent[0]?.body as { routines: unknown[]; runs: unknown[] };
  expect(body.routines).toEqual([{ id: "mine", botId: "alpha" }]);
  expect(body.runs).toEqual([{ id: "run-mine", botId: "alpha" }]);
});

test("a window that is not a number falls back to the manager's own default", async () => {
  calls.length = 0;
  await call(routes(), "/api/routines?from=abc&to=10");

  expect(calls).toEqual(["listRuns:undefined:10"]);
});

test("a routine aimed at a bot the caller cannot see reads as no such bot", async () => {
  const hidden = await call(routes(), "/api/routines", "POST", { botId: "hidden" });
  const visible = await call(routes(), "/api/routines", "POST", { botId: "alpha", prompt: "ring the bell" });

  expect(hidden.sent).toEqual([{ status: 404, body: { error: "no such bot" } }]);
  expect(visible.sent[0]?.status).toBe(201);
  expect(visible.sent[0]?.body).toEqual({ routine: { id: "new", botId: "alpha", prompt: "ring the bell" } });
});

test("the same rule holds for a room and for an edit", async () => {
  const hiddenCreate = await call(routes(), "/api/routines", "POST", { groupId: "hidden-room" });
  const hiddenPatch = await call(routes(), "/api/routines/mine", "PATCH", { groupId: "hidden-room" });
  const plainPatch = await call(routes(), "/api/routines/mine", "PATCH", { prompt: "later" });

  expect(hiddenCreate.sent[0]?.body).toEqual({ error: "no such channel" });
  expect(hiddenPatch.sent[0]?.body).toEqual({ error: "no such channel" });
  expect(plainPatch.sent[0]?.status).toBe(200);
});

test("running, cancelling and acknowledging a run answer for the routine named", async () => {
  const run = await call(routes(), "/api/routines/mine/run", "POST");
  const missing = await call(routes(), "/api/routines/gone/run", "POST");
  const cancelled = await call(routes(), "/api/routine-runs/run-mine/cancel", "POST");
  const seen = await call(routes(), "/api/routine-runs/run-mine/seen", "POST");
  const allSeen = await call(routes(), "/api/routine-runs/seen-all", "POST");
  const noSuchRun = await call(routes(), "/api/routine-runs/run-mine/cancel", "GET");

  expect(run.sent[0]?.status).toBe(201);
  expect(missing.sent).toEqual([{ status: 404, body: { error: "no such routine" } }]);
  expect(cancelled.sent[0]?.body).toEqual({ run: { id: "run-mine", status: "cancelled" } });
  expect(seen.sent[0]?.body).toEqual({ run: { id: "run-mine", seen: true } });
  expect(allSeen.sent[0]?.body).toEqual({ runs: [{ id: "run-mine", seen: true }] });
  expect(noSuchRun.out).toBe(PASS);
});

test("the shell's wake question is answered by the manager, not guessed here", async () => {
  const { sent } = await call(routes(), "/api/routines/wake");

  expect(sent).toEqual([{ status: 200, body: { hold: false, next: null } }]);
});

test("a results thread must belong to the caller on both create and edit", async () => {
  const create = await call(routes(), "/api/routines", "POST", { botId: "alpha", resultsThreadId: "private-dm" });
  const edit = await call(routes(), "/api/routines/mine", "PATCH", { resultsThreadId: "private-dm" });
  expect(create.sent).toEqual([{ status: 404, body: { error: "no such conversation" } }]);
  expect(edit.sent).toEqual([{ status: 404, body: { error: "no such conversation" } }]);
});
