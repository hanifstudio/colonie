// The team brief (section context) and team memory: two things a person owns
// for a named team.
//
// Bots receive the brief in system context, but no agent tool can write it —
// that keeps one bot from silently changing every teammate's future turns.
// Both surfaces require the `section` query parameter even for General (""),
// so a malformed client cannot accidentally read or replace a team's brief.
// Team memory distinguishes what a person adds (trusted immediately) from what
// a bot proposes (waits for a person to accept).
import { z } from "zod";
import {
  readSectionContext,
  sectionContextKey,
  sectionContextLabel,
  writeSectionContext,
  SECTION_CONTEXT_MAX_BYTES,
} from "../section-context.ts";
import { TEAM_MEMORY_KINDS, type TeamMemory, type TeamMemoryKind } from "../team-memory.ts";
import type { Store } from "../persistence/store.ts";
import { sectionKey } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamBriefRouteDeps {
  store: Store;
  teamMemory: TeamMemory;
}

export function createTeamBriefRoutes(deps: TeamBriefRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/team-memory" && (method === "GET" || method === "POST")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const section = sectionContextKey(url.searchParams.get("section") ?? "");
      if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      if (method === "GET") {
        return json(res, 200, { section, label: sectionContextLabel(section), entries: deps.teamMemory.list(section) });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !(TEAM_MEMORY_KINDS as readonly string[]).includes(String(body.kind))) {
        return json(res, 400, { error: `kind must be one of ${TEAM_MEMORY_KINDS.join(", ")}` });
      }
      try {
        const proposed = deps.teamMemory.propose(
          section,
          { kind: body.kind as TeamMemoryKind, name: String(body.name ?? ""), detail: String(body.detail ?? ""), aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : undefined },
          { botId: "", botName: "you", threadId: "", at: Date.now() },
        );
        // the person's own entry never waits on the person
        if (proposed.status === "proposed") deps.teamMemory.resolve(section, proposed.entry.id, "accept");
        return json(res, 201, { entries: deps.teamMemory.list(section) });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const memoryEntry = /^\/api\/team-memory\/([\w-]+)$/.exec(path);
    if (memoryEntry && (method === "PATCH" || method === "DELETE")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const section = sectionContextKey(url.searchParams.get("section") ?? "");
      if (method === "DELETE") {
        if (!deps.teamMemory.remove(section, memoryEntry[1]!)) return json(res, 404, { error: "no such entry" });
        return json(res, 200, { entries: deps.teamMemory.list(section) });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object") return json(res, 400, { error: "body must be a JSON object" });
      if (body.accept === true) {
        const result = deps.teamMemory.resolve(section, memoryEntry[1]!, "accept");
        if (!result.claimed) return json(res, 404, { error: "no such entry" });
        return json(res, 200, { entries: deps.teamMemory.list(section) });
      }
      const patch: { name?: string; detail?: string; aliases?: string[]; kind?: TeamMemoryKind } = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.detail === "string") patch.detail = body.detail;
      if (Array.isArray(body.aliases)) patch.aliases = body.aliases.map(String);
      if (typeof body.kind === "string" && (TEAM_MEMORY_KINDS as readonly string[]).includes(body.kind)) patch.kind = body.kind as TeamMemoryKind;
      try {
        const updated = deps.teamMemory.update(section, memoryEntry[1]!, patch);
        if (!updated) return json(res, 404, { error: "no such entry" });
        return json(res, 200, { entry: updated, entries: deps.teamMemory.list(section) });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (path === "/api/section-context" && (method === "GET" || method === "PUT")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const requested = url.searchParams.get("section") ?? "";
      const section = sectionContextKey(requested);
      if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      const exists =
        section === "" ||
        deps.store.sections.includes(section) ||
        deps.store.bots.some((bot) => !bot.hidden && sectionKey(bot.section) === section) ||
        deps.store.groups.some((group) => sectionKey(group.section) === section);
      if (!exists) return json(res, 404, { error: "no such team" });

      if (method === "GET") {
        const context = readSectionContext(section);
        return json(res, 200, {
          section,
          label: sectionContextLabel(section),
          text: context?.text ?? "",
          updatedAt: context?.updatedAt ?? null,
          maxBytes: SECTION_CONTEXT_MAX_BYTES,
        });
      }

      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      if (Buffer.byteLength(parsed.data.text, "utf8") > SECTION_CONTEXT_MAX_BYTES) {
        return json(res, 400, { error: `section context is capped at ${SECTION_CONTEXT_MAX_BYTES / 1000}KB` });
      }
      const context = writeSectionContext(section, parsed.data.text);
      return json(res, 200, {
        ok: true,
        section,
        label: sectionContextLabel(section),
        text: context?.text ?? "",
        updatedAt: context?.updatedAt ?? null,
        maxBytes: SECTION_CONTEXT_MAX_BYTES,
      });
    }
    return PASS;
  };
}