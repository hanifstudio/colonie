// Routines and their runs: the schedule a person (or a bot on their behalf)
// keeps, and the runs it produced.
//
// Two rules ride along with the routes themselves. Every listing is filtered
// through the viewer's VisibleSet, so a member never learns that a hidden
// bot's routine exists by seeing its run in the calendar. And a routine may
// only be aimed at a bot or room the caller can see: a hidden target reads
// as "no such bot"/"no such channel" rather than as a refusal.
import { routineVisible, type VisibleSet } from "../colonie/bots/bot-visibility.ts";
import type { Routine, RoutineInput, RoutineManager } from "../colonie/routines/routines.ts";
import type { Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RoutineRouteDeps {
  routines: RoutineManager;
  store: Store;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  contextForCreate?: (auth: RequestAuth, input: RoutineInput) => Pick<Routine, "sourceThreadId" | "conversation"> | undefined;
}

/** A member may schedule a routine only for a bot or room they can see. */
function hiddenRoutineTarget(body: unknown, visible: VisibleSet, store: Store): string | null {
  if (visible.everything || !body || typeof body !== "object") return null;
  const { botId, groupId } = body as { botId?: unknown; groupId?: unknown };
  if (typeof botId === "string" && store.bot(botId) && !visible.bot(botId)) return "no such bot";
  if (typeof groupId === "string" && store.group(groupId) && !visible.group(groupId)) return "no such channel";
  return null;
}

export function createRoutineRoutes(deps: RoutineRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const mine =
      path === "/api/routines" ||
      path.startsWith("/api/routines/") ||
      path === "/api/routine-runs/seen-all" ||
      path.startsWith("/api/routine-runs/");
    if (!mine) return PASS;

    const visible = deps.visibleFor(auth);

    if (path === "/api/routines" && method === "GET") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const from = fromParam == null ? undefined : Number(fromParam);
      const to = toParam == null ? undefined : Number(toParam);
      return json(res, 200, {
        routines: deps.routines.listRoutines().filter((routine) => routineVisible(routine, visible)),
        runs: deps.routines.listRuns(from != null && Number.isFinite(from) ? from : undefined, to != null && Number.isFinite(to) ? to : undefined)
          .filter((run) => routineVisible(run, visible)),
      });
    }
    if (path === "/api/routines" && method === "POST") {
      const body = await readBody(req);
      const hidden = hiddenRoutineTarget(body, visible, deps.store);
      if (hidden) return json(res, 404, { error: hidden });
      if (typeof body.resultsThreadId === "string" && !visible.thread(body.resultsThreadId)) return json(res, 404, { error: "no such conversation" });
      const routine = deps.routines.create(body, undefined, deps.contextForCreate?.(auth, body));
      return json(res, 201, { routine });
    }
    // The desktop shell polls this to decide whether to hold the computer
    // awake: a run in flight, or a routine due within the hour.
    if (path === "/api/routines/wake" && method === "GET") {
      return json(res, 200, deps.routines.wakeHold());
    }
    let routineMatch = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (routineMatch && method === "POST") {
      const run = deps.routines.runNow(routineMatch[1]);
      return run ? json(res, 201, { run }) : json(res, 404, { error: "no such routine" });
    }
    routineMatch = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (routineMatch && method === "PATCH") {
      const body = await readBody(req);
      const hidden = hiddenRoutineTarget(body, visible, deps.store);
      if (hidden) return json(res, 404, { error: hidden });
      if (typeof body.resultsThreadId === "string" && !visible.thread(body.resultsThreadId)) return json(res, 404, { error: "no such conversation" });
      const routine = deps.routines.update(routineMatch![1], body);
      return routine ? json(res, 200, { routine }) : json(res, 404, { error: "no such routine" });
    }
    if (routineMatch && method === "DELETE") {
      const removed = deps.routines.remove(routineMatch[1]);
      return removed
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such routine" });
    }
    if (path === "/api/routine-runs/seen-all" && method === "POST") {
      return json(res, 200, { runs: deps.routines.markAllSeen((run) => routineVisible(run, visible)) });
    }
    const runMatch = path.match(/^\/api\/routine-runs\/([\w-]+)\/(cancel|seen)$/);
    if (runMatch && method === "POST") {
      const run = runMatch[2] === "cancel"
        ? await deps.routines.cancelRun(runMatch[1])
        : deps.routines.markSeen(runMatch[1]);
      return run ? json(res, 200, { run }) : json(res, 404, { error: "no such active run" });
    }

    return PASS;
  };
}
