// The skills library (features.skillsLibrary): the local browse surface.
//
// Everything here is local — the library on disk, assignments on bot records,
// imports from pasted SKILL.md text. No registry, no network.
import { z } from "zod";
import { skillsLibraryEnabled, type AppConfig } from "../config.ts";
import {
  installLibrarySkill,
  listLibrarySkills,
  readLibrarySkillFile,
  readSkillLibraryIndex,
  setLibrarySkillReviewState,
} from "../skill-library.ts";
import { parseSkillMd, scanSkillText } from "../skills.ts";
import type { SkillsLibrarySkillWire } from "../../shared/wire.ts";
import type { Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SkillsLibraryRouteDeps {
  cfg: AppConfig;
  store: Store;
}

export function createSkillsLibraryRoutes(deps: SkillsLibraryRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const root = path.match(/^\/api\/skills-library$/);
    if (root && method === "GET") {
      if (!skillsLibraryEnabled(deps.cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const index = readSkillLibraryIndex();
      const skills: SkillsLibrarySkillWire[] = listLibrarySkills()
        .map((listing): SkillsLibrarySkillWire => ({
          name: listing.name,
          description: listing.description,
          source: listing.source,
          enabled: listing.enabled,
          tags: listing.tags ?? [],
          version: index[listing.name]?.package?.release ?? null,
          importedAt: listing.importedAt,
          ...(listing.license ? { license: listing.license } : {}),
          ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
          warnings: listing.warnings,
          assignedBots: deps.store.bots
            .filter((bot) => bot.assignedSkills?.includes(listing.name))
            .map((bot) => ({ id: bot.id, name: bot.name })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { skills });
    }
    if (root && method === "POST") {
      if (!skillsLibraryEnabled(deps.cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const parsed = z.object({ text: z.string().min(1) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be the SKILL.md contents to import" });
      const skill = parseSkillMd(parsed.data.text);
      if ("error" in skill) return json(res, 400, { error: skill.error });
      // Imports land disabled with their scan warnings attached: enabling is
      // a separate, explicit review step on the row.
      const installed = installLibrarySkill({
        name: skill.name,
        instructions: parsed.data.text,
        source: "local-import",
        license: skill.license,
        compatibility: skill.compatibility,
        tags: skill.tags,
        warnings: scanSkillText(parsed.data.text),
        reviewState: "disabled",
      });
      if ("error" in installed) return json(res, 422, { error: installed.error });
      return json(res, 201, { skill: installed });
    }
    const one = path.match(/^\/api\/skills-library\/([a-z0-9-]+)$/);
    if (one && method === "GET") {
      if (!skillsLibraryEnabled(deps.cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const text = readLibrarySkillFile(one[1]!);
      if (text === null) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { text });
    }
    if (one && method === "PATCH") {
      if (!skillsLibraryEnabled(deps.cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      const result = setLibrarySkillReviewState(one[1]!, parsed.data.enabled ? "approved" : "disabled");
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    const assigned = path.match(/^\/api\/bots\/([\w-]+)\/skills-library$/);
    if (assigned && method === "PUT") {
      if (!skillsLibraryEnabled(deps.cfg)) return json(res, 404, { error: "skills library is not enabled" });
      if (!deps.store.bot(assigned[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ skills: z.array(z.string().min(1).max(64)).max(200) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "skills must be a list of skill names" });
      const index = readSkillLibraryIndex();
      const names = [...new Set(parsed.data.skills)];
      const unknown = names.filter((name) => !index[name]);
      if (unknown.length) return json(res, 422, { error: "not in the library: " + unknown.join(", ") });
      deps.store.patchBot(assigned[1]!, { assignedSkills: names });
      return json(res, 200, { assignedSkills: names });
    }
    return PASS;
  };
}