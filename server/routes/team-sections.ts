// Named teams (the sidebar sections): list, rename, delete, move members.
//
// Teams are a view over workspace bots, so every mutation goes through the
// store's own membership rules — a team can hold only one Chief of Staff, and
// membership that changed under the dialog is refused rather than guessed.
import { z } from "zod";
import type { BotRecord, Store } from "../persistence/store.ts";
import type { TeamComputers } from "../colonie/teams/team-computers.ts";
import type { WireBot } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamSectionRouteDeps {
  store: Store;
  teamComputers: TeamComputers;
  wireBot: (bot: BotRecord) => WireBot;
  maxWorkspaceBots: number;
}

export function createTeamSectionRoutes(deps: TeamSectionRouteDeps): RouteHandler {
  const botIds = z.array(z.string().regex(/^[\w-]+$/)).max(deps.maxWorkspaceBots);
  const createBody = z.object({ name: z.string(), botIds: botIds.default([]) }).strict();
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/sidebar-sections" && method === "GET") {
      return json(res, 200, { sections: deps.store.sections });
    }
    if (path === "/api/sidebar-sections" && (method === "PATCH" || method === "DELETE")) {
      const section = url.searchParams.get("section")?.trim();
      if (!section) return json(res, 400, { error: "Choose a named team" });
      if (method === "DELETE" && deps.teamComputers.forSection(section)) return json(res, 409, { error: "Unassign this team's computer before deleting the team" });
      let nextName: string | null = null;
      if (method === "PATCH") {
        const parsed = z.object({ name: z.string().trim().min(1).max(60) }).strict().safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "Team name must be 1 to 60 characters" });
        nextName = parsed.data.name;
      }
      const error = nextName === null ? deps.store.deleteSection(section) : deps.store.renameSection(section, nextName, deps.teamComputers);
      if (error) return json(res, error === "No such team" ? 404 : 409, { error });
      return json(res, 200, { sections: deps.store.sections });
    }
    if (method === "PUT" && path === "/api/sidebar-sections") {
      const section = url.searchParams.get("section")?.trim();
      if (!section || !deps.store.sections.includes(section)) return json(res, 404, { error: "No such team" });
      const parsed = z.object({ addBotIds: botIds, removeBotIds: botIds }).strict().safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Provide addBotIds and removeBotIds" });
      const result = deps.store.updateTeamMembers(section, parsed.data.addBotIds, parsed.data.removeBotIds);
      if (!result.ok) return json(res, result.reason === "unavailable" ? 404 : 409, { error:
        result.reason === "chief-conflict" ? "A team can have only one Chief of Staff. Change the Chief before moving this bot."
          : result.reason === "membership-changed" ? "Team membership changed. Reopen the dialog and try again."
          : "One or more bots are unavailable" });
      return json(res, 200, { sections: deps.store.sections, bots: result.bots.map(deps.wireBot) });
    }
    if (method === "POST" && path === "/api/sidebar-sections") {
      const parsed = createBody.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "Provide a team name and up to 100 valid botIds" });
      }
      const name = parsed.data.name.trim();
      if (name.length > 60) {
        return json(res, 400, { error: "name must be at most 60 characters" });
      }
      const ids = [...new Set(parsed.data.botIds)];
      if (!name && !ids.length) return json(res, 400, { error: "Team name is required" });
      const result = deps.store.setBotsSection(ids, name);
      if (!result.ok) {
        if (result.reason === "chief-conflict") {
          return json(res, 409, {
            error: "A team can have only one Chief of Staff. Choose one Chief or use a team without one.",
          });
        }
        return json(res, 404, { error: "one or more bots are unavailable" });
      }
      return json(res, 200, { section: name, sections: deps.store.sections, bots: result.bots.map(deps.wireBot) });
    }
    return PASS;
  };
}