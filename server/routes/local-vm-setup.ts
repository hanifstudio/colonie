// Set up a bot's computer in one step (owner, October 29): when a person
// chooses Local VM, the app asks here, and the server starts the installed
// container runtime, prepares the Cua desktop the first time, and creates or
// starts the bot's Local VM, the same readiness a turn on it goes through.
// A runtime that is not installed stays the person's step, named in the
// status the panel shows.
import type { ContainerComputerStatus, LocalVmTarget } from "../colonie/computer/container-computer.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createLocalVmSetupRoute(deps: {
  bot: (id: string) => { id: string } | undefined;
  target: (botId: string) => LocalVmTarget;
  /** A turn holds this desktop, or a setup action on it is running. */
  busy: (target: LocalVmTarget) => boolean;
  ready: (botId: string, target: LocalVmTarget) => Promise<ContainerComputerStatus>;
  seen: (target: LocalVmTarget) => void;
}): RouteHandler {
  return async ({ req, res, path, method, json }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/setup$/);
    if (!m) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const bot = deps.bot(m[1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    const target = deps.target(bot.id);
    if (deps.busy(target)) return json(res, 409, { error: "this computer is busy; it is being set up or used" });
    try {
      const status = await deps.ready(bot.id, target);
      if (status.ready) deps.seen(target);
      return json(res, 200, status);
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
