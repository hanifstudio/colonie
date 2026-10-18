// Defaults for a bot that does not exist yet: the New bot dialog's starting
// profile, the skills previewed from a source, and an avatar preview.
//
// Previews belong to the draft. Nothing here writes a bot, a skill or an
// image: the avatar comes back as a data URL for the form, and the skills as
// unsaved templates the form submits with the create call.
import { z } from "zod";
import { newBotDefaultsSchema, botSkillTemplateSchema } from "../new-bot-defaults.ts";
import { pickBotName } from "../names.ts";
import { fetchSkillFromSource } from "../colonie/skills/skill-fetch.ts";
import { parseSkillMd, scanSkillText } from "../colonie/skills/skills.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { avatarGenerationRequestSchema, generateAvatarImage } from "../avatar-image.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../persistence/store.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotDefaultRouteDeps {
  cfg: AppConfig;
  store: Store;
  /** The model the next bot would start on; index.ts owns how it is chosen. */
  defaultSelection: () => Promise<ModelSelection>;
}

export function createBotDefaultRoutes(deps: BotDefaultRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/bot-defaults") {
      return json(res, 200, {
        defaults: structuredClone(deps.cfg.newBotDefaults ?? newBotDefaultsSchema.parse({})),
        modelSelection: await deps.defaultSelection(),
        suggestedName: pickBotName(deps.store.bots.map(bot => bot.name)),
      });
    }
    if (method === "POST" && path === "/api/bot-defaults/skills/preview") {
      const checked = z.object({ source: z.string().min(1).max(2000) }).strict().safeParse(await readBody(req));
      if (!checked.success) return json(res, 400, { error: checked.error.message });
      const input = checked.data;
      const fetched = await fetchSkillFromSource(input.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const skills = [];
      for (const skill of fetched.skills) {
        const file = skill.files.find(file => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
        if (!file) continue;
        const parsed = parseSkillMd(file.content);
        if ("error" in parsed) return json(res, 422, { error: parsed.error });
        const skippedWarnings = skill.files.filter(candidate => candidate !== file)
          .map(candidate => `skipped supporting file "${candidate.path}" — v1 imports only SKILL.md`);
        const template = botSkillTemplateSchema.safeParse({ name: parsed.name, description: parsed.description, source: skill.source, text: file.content,
          enabled: false, warnings: [...scanSkillText(file.content), ...skippedWarnings] });
        if (!template.success) return json(res, 422, { error: template.error.message });
        skills.push(template.data);
      }
      return json(res, 200, { skills });
    }
    if (method === "POST" && path === "/api/bot-defaults/avatar") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "avatar preview must be a JSON object" });
      const profile = parseBotProfilePatch(body.profile, true);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      const checked = avatarGenerationRequestSchema.safeParse({ prompt: body.prompt });
      if (!checked.success) return json(res, 400, { error: checked.error.message });
      const { prompt } = checked.data;
      const generated = await generateAvatarImage(deps.cfg, {
        name: profile.patch.name ?? "", title: profile.patch.title ?? "", description: profile.patch.description ?? "",
      }, prompt);
      // A preview belongs to the draft. Upload it through the existing image
      // endpoint only when the user commits the new bot or its defaults.
      return json(res, 200, { dataUrl: `data:${generated.mime};base64,${generated.bytes.toString("base64")}` });
    }
    return PASS;
  };
}