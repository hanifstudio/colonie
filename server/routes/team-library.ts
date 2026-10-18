// The team library and the project scout: read-only routes that answer with a
// proposal. Nothing here creates a bot or a team — bots and rooms come into
// being only when the human sends the suggested manifest through
// POST /api/teams/import, so "the agent proposes, the person imports" is
// enforced by the route split itself.
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "../team-library.ts";
import { scoutProject, suggestTeam } from "../project-scout.ts";
import { fetchBotDirectory, matchDirectoryBots, type MatchedDirectoryBot } from "../colonie/bots/bot-directory.ts";
import { validateBotCwd } from "../colonie/bots/bot-cwd.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const teamLibraryRoutes: RouteHandler = async ({ req, res, url, path, method, json, readBody }) => {
  if (method === "GET" && path === "/api/team-library/catalog") {
    try {
      return json(res, 200, await fetchTeamCatalog());
    } catch (error) {
      return json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
    }
  }
  const libraryTeam = /^\/api\/team-library\/teams\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  if (libraryTeam && method === "GET") {
    try {
      return json(res, 200, await fetchLibraryTeam(libraryTeam[1]));
    } catch (error) {
      const status = (error as { status?: number }).status === 404 ? 404 : 502;
      return json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
    }
  }
  if (method === "POST" && path === "/api/team-library/github") {
    const body = await readBody(req);
    if (typeof body.url !== "string" || !body.url.trim()) {
      return json(res, 400, { error: "A GitHub URL is required" });
    }
    try {
      return json(res, 200, await fetchGithubTeam(body.url));
    } catch (error) {
      const status = (error as { status?: number }).status === 404 ? 404 : 400;
      return json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
    }
  }
  // The scout reads a folder and answers with a suggestion — it creates
  // nothing. The folder is whatever validateBotCwd accepts: the same
  // local-user trust boundary as pointing any bot's working folder at a path.
  // Deliberately offline — the community directory lives on its own route
  // below, so a slow network can never delay the suggestion.
  if (method === "GET" && path === "/api/teams/scout") {
    const validated = validateBotCwd(url.searchParams.get("cwd"));
    if (!validated.ok) return json(res, 400, { error: validated.error });
    if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
    const profile = scoutProject(validated.cwd);
    return json(res, 200, { profile, suggestion: suggestTeam(profile) });
  }
  // Community bots that fit the scouted folder — a separate, lazy call so an
  // unreachable directory degrades to "no extra candidates", never to a broken
  // scout.
  if (method === "GET" && path === "/api/teams/scout/directory") {
    const validated = validateBotCwd(url.searchParams.get("cwd"));
    if (!validated.ok) return json(res, 400, { error: validated.error });
    if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
    let directory: MatchedDirectoryBot[] = [];
    try {
      directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
    } catch (error) {
      // an unreachable directory is a fact of life, not an error — but an
      // empty section should still be diagnosable from the server log
      console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
    }
    return json(res, 200, { directory });
  }
  return PASS;
};