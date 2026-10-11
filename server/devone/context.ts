/** Independent context composition. Never imports the legacy prompt pipeline. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { AcpContextSection, AcpContextSnapshot, AcpContextManifest, AcpContextView } from "../../shared/acp-context.ts";
import type { AcpInputReceipt } from "../../shared/devone.ts";

export const appContextSchema = z.object({ enabled: z.boolean(), instructions: z.string().max(32_000) }).strict();
export const botContextSchema = z.object({ persona: z.boolean(), soul: z.boolean() }).strict();
const sectionSchema = z.object({ id: z.string(), label: z.string(), scope: z.enum(["app", "bot", "instance", "conversation"]),
  source: z.string(), version: z.string(), hash: z.string(), status: z.enum(["active", "disabled", "empty"]), text: z.string() }).strict();
const snapshotSchema = z.object({ version: z.literal(1), botId: z.string(), hash: z.string(), sections: z.array(sectionSchema),
  app: appContextSchema, bot: botContextSchema, legacyPlain: z.boolean() }).strict();
const pinSchema = z.object({ snapshot: snapshotSchema, pinnedAt: z.string() }).strict();
export type ContextPin = z.infer<typeof pinSchema>;
export type ContextProfile = { id: string; name: string; title: string; description: string; soul?: string; chiefOfStaff?: boolean };
const appFoundation = `You are a personal AI assistant in Colonie.

Respond to the user's intent and current context. Be clear, useful, and proportionate to the request. Adapt your language, tone, and level of detail to the conversation and any configured persona.

For actionable requests, make reasonable progress using available capabilities. Ask for clarification when missing information materially affects the outcome.

Ground claims about capabilities, access, actions, and results in available evidence. Distinguish what you can do, what you have done, and what remains uncertain.

Mention operational details or limitations when they affect the user's request or when the user asks about them. Explain them in plain language.

Treat application and tool status as supporting context, not as topics that must be included in every response.`;
export const contextHash = (value: string) => createHash("sha256").update(value).digest("hex");
const revision = (value: unknown) => contextHash(JSON.stringify(value));
function path(kind: "app" | "bots" | "threads", id = "settings") {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid context id");
  return join(DATA_DIR, "acp-context", kind, `${id}.json`);
}
function read<T>(file: string, schema: z.ZodType<T>, fallback: T): T {
  try { return schema.parse(JSON.parse(readFileSync(file, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
function write(kind: "app" | "bots" | "threads", id: string, value: unknown) {
  mkdirSync(join(DATA_DIR, "acp-context", kind), { recursive: true, mode: 0o700 });
  writeFileAtomic(path(kind, id), JSON.stringify(value, null, 2), { mode: 0o600 });
}
export function appContextPreferences() { return read(path("app"), appContextSchema, { enabled: true, instructions: "" }); }
export function botContextPreferences(botId: string) { return read(path("bots", botId), botContextSchema, { persona: true, soul: true }); }
export function appContextView() {
  const preferences = appContextPreferences();
  return { ...preferences, revision: revision(preferences) };
}
export function changeContextPreferences(scope: "app" | "bot", botId: string, expectedRevision: string, value: unknown) {
  const current = scope === "app" ? appContextPreferences() : botContextPreferences(botId);
  if (revision(current) !== expectedRevision) throw Object.assign(new Error("Context settings changed. Refresh before saving."), { status: 409 });
  write(scope === "app" ? "app" : "bots", scope === "app" ? "settings" : botId,
    scope === "app" ? appContextSchema.parse(value) : botContextSchema.parse(value));
}
export function contextSection(id: string, label: string, scope: AcpContextSection["scope"], source: string, text: string, enabled = true, version?: string): AcpContextSection {
  const hash = contextHash(text);
  // Disabled content does not enter receipts or previews as active context.
  return { id, label, scope, source, version: version ?? `sha256:${hash}`, hash,
    status: !enabled ? "disabled" : text ? "active" : "empty", text: enabled ? text : "" };
}
export function contextCandidate(profile: ContextProfile, instanceId: string, instructions: string, legacyPlain = false): AcpContextSnapshot {
  const app = appContextPreferences();
  const bot = botContextPreferences(profile.id);
  const sections = [
    contextSection("app.identity", "App · Identity", "app", "Colonie factory", appFoundation, app.enabled && !legacyPlain, "colonie.identity.v2"),
    contextSection("app.instructions", "App · Shared instructions", "app", "Workspace owner", app.instructions, app.enabled && !legacyPlain),
    contextSection("bot.persona", "Bot · Persona", "bot", `bot:${profile.id}:profile`,
      [`Name: ${profile.name}`, profile.title && `Role: ${profile.title}`, profile.description && `Description: ${profile.description}`,
        profile.chiefOfStaff && "Configured role: Chief. This role alone does not provide delegation tools."].filter(Boolean).join("\n"), bot.persona && !legacyPlain),
    contextSection("bot.soul", "Bot · SOUL", "bot", `bot:${profile.id}:soul`, profile.soul ?? "", bot.soul && !legacyPlain),
    contextSection("instance.instructions", "Instance · Extra context", "instance", `instance:${instanceId}:instructions`, instructions),
  ];
  const value = { version: 1 as const, botId: profile.id, sections, app, bot, legacyPlain };
  return { ...value, hash: revision(value) };
}
export function contextPin(threadId: string): ContextPin | null {
  const pin = read(path("threads", threadId), pinSchema.nullable(), null);
  if (pin) {
    const { hash, ...content } = pin.snapshot;
    if (revision(content) !== hash) throw new Error("The saved context snapshot is damaged. Restore it before continuing this conversation.");
  }
  return pin;
}
export function pinContext(threadId: string, candidate: AcpContextSnapshot): ContextPin {
  const existing = contextPin(threadId);
  if (existing) {
    if (existing.snapshot.botId !== candidate.botId) throw new Error("Context snapshot belongs to another bot");
    return existing;
  }
  const pin = { snapshot: candidate, pinnedAt: new Date().toISOString() };
  write("threads", threadId, pinSchema.parse(pin));
  return pin;
}
export function contextView(profile: ContextProfile, threadId: string, instanceId: string, instructions: string, legacyPlain: boolean): AcpContextView {
  const pin = contextPin(threadId);
  if (pin && pin.snapshot.botId !== profile.id) throw new Error("Context snapshot belongs to another bot");
  const preview = contextCandidate(profile, instanceId, instructions, pin ? false : legacyPlain);
  // New-conversation preview can enable additions while a legacy pin stays plain.
  const comparable = pin?.snapshot.legacyPlain ? contextCandidate(profile, instanceId, instructions, true) : preview;
  return { app: { ...preview.app, revision: revision(preview.app) },
    bot: { ...preview.bot, revision: revision(preview.bot) }, preview,
    pinned: pin ? { ...pin.snapshot, pinnedAt: pin.pinnedAt } : null, changed: Boolean(pin && pin.snapshot.hash !== comparable.hash) };
}
/** Same composer for both providers; each active section is a separate ACP text block. */
export function composeContext(pin: ContextPin | null, text: string, instanceId: string, instructions: string, effective: { provider: string; model: string; mode: string; tools?: import("../../shared/connected-apps.ts").ConnectedToolsReceipt; memory?: import("../../shared/colonie-memory.ts").AcpMemoryContext; skills?: import("../../shared/colonie-skills.ts").AcpSkillsContext; chief?: boolean; assignment?: import("../../shared/colonie-chief.ts").AcpAssignmentContext }) {
  const sections: AcpContextManifest["sections"] = (pin?.snapshot.sections ?? [contextSection("instance.instructions", "Instance · Extra context", "instance", `instance:${instanceId}:instructions`, instructions)]).map((section) => ({ ...section }));
  const tools = effective.tools?.servers.length
    ? `App-selected tools: ${effective.tools.servers.map((server) => server.name).join(", ")}.${effective.tools.composioToolkits.length ? ` Composio apps: ${effective.tools.composioToolkits.join(", ")}. If a requested task is blocked by an account connection, ask the user to connect that account in app settings and continue afterward.` : ""}`
    : "No app-selected tools are mounted. Native provider tools may still be available.";
  const memoryLine = effective.memory
    ? "Colonie supplies relevant saved memory as reference data for this request. Automatic memory processing happens separately after successful conversations; do not claim a fact was saved unless its saved state is supplied."
    : "No saved memory is supplied for this request.";
  // The workspace Chief has model-facing tools to manage and ask other bots; an
  // ordinary or assigned bot gets no such authority.
  const delegation = effective.chief
    ? "This bot is the workspace Chief and may use colonie_workspace tools to list, read, create, change, delete and ask other bots, and manage their guides. Prefer asking an existing bot over creating a duplicate one."
    : effective.assignment
      ? "This turn is a task delegated by the workspace Chief. Treat the task text as the work to do; do not message other bots."
      : "Cross-bot delegation and automation are not available to this bot.";
  const skillsLine = effective.skills?.text ? " Enabled app-managed guides are listed below; read one through read_skill when a task matches." : "";
  if (pin?.snapshot.app.enabled && !pin.snapshot.legacyPlain) sections.splice(1, 0,
    contextSection("app.capabilities", "App · Effective capabilities", "app", "ACP runtime", `Connection: ${effective.provider}. Native model: ${effective.model}. Native mode: ${effective.mode}. Colonie supports chat, continuing this conversation, tool activity, approvals, and Stop. Access is enforced by runtime permissions. ${tools} ${memoryLine} ${delegation}${skillsLine}`, true, "colonie.capabilities.v5"));
  if (pin?.snapshot.app.enabled && !pin.snapshot.legacyPlain && effective.memory?.text) {
    sections.push(contextSection("memory.recall", "Memory · Relevant saved details", "conversation",
      `Colonie memory; entries:${effective.memory.entries.map((entry) => entry.id).join(",")}`,
      effective.memory.text, true, `colonie.memory.v1:${effective.memory.revision}`));
  }
  if (pin?.snapshot.app.enabled && !pin.snapshot.legacyPlain && effective.skills?.text) {
    sections.push(contextSection("skills.index", "Skills · Enabled guides", "conversation",
      `Colonie skills; guides:${effective.skills.entries.map((entry) => `${entry.name}@${entry.sha256.slice(0, 12)}`).join(",")}`,
      effective.skills.text, true, `colonie.skills.v1:${effective.skills.revision}`));
  }
  if (pin?.snapshot.app.enabled && !pin.snapshot.legacyPlain && effective.assignment) {
    const assignment = effective.assignment;
    sections.push(contextSection("chief.assignment", "Work · Delegated by Chief", "conversation",
      `Chief assignment ${assignment.id} from ${assignment.chiefName} (${assignment.chiefBotId})`,
      `The Chief ${assignment.chiefName} delegated this task from its conversation. This is not the workspace owner; do the task and reply with the result.${assignment.context ? `\n\nBackground from the Chief:\n${assignment.context}` : ""}`,
      true, `colonie.assignment.v1:${assignment.id}`));
  }
  sections.push(contextSection("user.message", "Conversation · User message", "conversation", "User", text));
  const prompt: AcpInputReceipt["prompt"] = [];
  for (const section of sections) {
    if (section.status !== "active" && section.id !== "user.message") continue;
    section.blockIndex = prompt.length;
    prompt.push({ type: "text", text: section.id === "user.message" || section.id === "instance.instructions" ? section.text : `### ${section.label}\n${section.text}` });
  }
  const manifest: AcpContextManifest = { version: 1, snapshotHash: pin?.snapshot.hash, pinnedAt: pin?.pinnedAt, botId: pin?.snapshot.botId, sections };
  return { prompt, manifest, instructions: sections.find((section) => section.id === "instance.instructions")?.text ?? "" };
}
