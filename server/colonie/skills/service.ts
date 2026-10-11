// The Colonie skills service: one bot's guides, read and edited in plain
// words. It owns the SKILL.md envelope so a person types a name, a "when to
// use" line and instructions, never YAML. Everything else is the existing
// upstream store: private guides go through stageSkillWrite +
// applyStagedSkillWrite (editable learned revisions, conflict-safe updates),
// imports land disabled through installSkill, and shared library guides are
// assigned through BotRecord.assignedSkills.
//
// Concurrency is stateless: `revision` is a content hash of the merged view
// plus the assignment list, so a client that read a stale view gets 409 and
// keeps its draft. No new ledger, no feature flag; private names shadow
// library names exactly as the dispatch path resolves them.
import { createHash } from "node:crypto";
import { redactSecretsInText } from "../../redact.ts";
import { fetchSkillFromSource } from "../../skill-fetch.ts";
import { LEARN_SOURCE_PREFIX } from "../../skill-learn.ts";
import {
  applyStagedSkillWrite,
  INDEX_MAX_BYTES,
  INDEX_MAX_SKILLS,
  installSkill,
  listBotSkillsWithOrigin,
  listSkills,
  readSkillFile,
  removeSkill,
  setSkillEnabled,
  stageSkillWrite,
  type SkillListing,
} from "../../skills.ts";
import {
  listLibrarySkills,
  readLibrarySkillFile,
  type LibrarySkillListing,
} from "../../skill-library.ts";
import { DESCRIPTION_MAX, isSkillName } from "../../../shared/skill-md.ts";
import type {
  AcpSkillsContext,
  ColonieSkill,
  ColonieSkillActor,
  ColonieSkillContent,
  ColonieSkillsView,
} from "../../../shared/colonie-skills.ts";

export interface SkillsBot {
  id: string;
  assignedSkills?: string[];
}

export interface ColonieSkillsDeps {
  bot(id: string): SkillsBot | undefined;
  setAssigned(id: string, names: string[]): void;
  busy(id: string): boolean;
}

export interface SaveSkillInput {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  expectedSha256?: string;
}

const COLONIE_SOURCE = `${LEARN_SOURCE_PREFIX}colonie`;

function fail(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** A stable, content-derived revision so a stale client edit is refused
 * without a separate persisted counter. */
function revisionOf(skills: readonly ColonieSkill[], assigned: readonly string[]): string {
  const basis = JSON.stringify({
    skills: skills.map((skill) => [skill.name, skill.sha256, skill.enabled, skill.origin, skill.source]),
    assigned: [...assigned].sort(),
  });
  return createHash("sha256").update(basis).digest("hex");
}

function toColonie(skill: SkillListing | LibrarySkillListing, origin: "private" | "library"): ColonieSkill {
  return {
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    source: skill.source,
    sha256: skill.sha256,
    editable: "editable" in skill ? skill.editable : false,
    origin,
    warnings: [...skill.warnings],
  };
}

/** Author a valid SKILL.md: JSON-quoted frontmatter values stay one-line and
 * safe for the minimal frontmatter reader. */
function buildSkillMd(name: string, description: string, instructions: string): string {
  const body = instructions.endsWith("\n") ? instructions : `${instructions}\n`;
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

function scrub(value: string, label: string): string {
  const clean = redactSecretsInText(value);
  if (clean !== value) throw fail(`The ${label} looks like it contains a secret; remove it and try again.`, 400);
  return value;
}

export class ColonieSkills {
  private readonly deps: ColonieSkillsDeps;

  constructor(deps: ColonieSkillsDeps) {
    this.deps = deps;
  }

  private assigned(botId: string): string[] {
    return [...(this.deps.bot(botId)?.assignedSkills ?? [])];
  }

  private compose(botId: string): { skills: ColonieSkill[]; library: ColonieSkill[]; assigned: string[] } {
    const assigned = this.assigned(botId);
    const merged = listBotSkillsWithOrigin(botId, assigned);
    return {
      skills: merged.skills.map((skill) => toColonie(skill, skill.origin)),
      library: merged.library.map((skill) => toColonie(skill, "library")),
      assigned,
    };
  }

  view(botId: string): ColonieSkillsView {
    const composed = this.compose(botId);
    return {
      revision: revisionOf(composed.skills, composed.assigned),
      skills: composed.skills,
      library: composed.library,
      assignedSkills: composed.assigned,
    };
  }

  private assertRevision(botId: string, expected?: string): void {
    if (expected === undefined) return;
    if (this.view(botId).revision !== expected) {
      throw fail("These guides changed elsewhere. Refresh and try again.", 409);
    }
  }

  private assertMutable(botId: string, creatingSelf: boolean, actor?: ColonieSkillActor): void {
    if (!this.deps.busy(botId)) return;
    if (creatingSelf && actor?.botId === botId) return;
    throw fail("This bot is busy. Try again when it finishes.", 409);
  }

  /** Full SKILL.md for review, including a disabled but intact guide. */
  read(botId: string, name: string): ColonieSkillContent | null {
    if (!isSkillName(name)) return null;
    const own = listSkills(botId).find((skill) => skill.name === name);
    if (own) {
      const text = readSkillFile(botId, name);
      return text === null ? null : { skill: toColonie(own, "private"), text };
    }
    const library = listLibrarySkills().find((skill) => skill.name === name);
    if (!library) return null;
    const text = readLibrarySkillFile(name);
    return text === null ? null : { skill: toColonie(library, "library"), text };
  }

  /** The scoped read body for a dispatch: enabled and intact only, private
   * shadowing library, keyed to the exact sha256 the index advertised. */
  readEnabled(botId: string, name: string): { text: string; sha256: string } | null {
    const skill = this.compose(botId).skills.find((entry) => entry.name === name);
    if (!skill || !skill.enabled) return null;
    const text = skill.origin === "private" ? readSkillFile(botId, name) : readLibrarySkillFile(name);
    if (text === null) return null;
    return { text, sha256: skill.sha256 };
  }

  /** The bounded named index a dispatch carries. Bodies never ride the
   * prompt; the model reads one through the scoped read tool when a task
   * matches. Native project/provider instructions stay authoritative. */
  context(botId: string): AcpSkillsContext {
    const composed = this.compose(botId);
    const enabled = composed.skills.filter((skill) => skill.enabled && skill.description && skill.sha256);
    const entries: ColonieSkill[] = [];
    const lines: string[] = [];
    for (const skill of enabled.slice(0, INDEX_MAX_SKILLS)) {
      const next = [...lines, `- ${skill.name} (sha256 ${skill.sha256}): ${skill.description}`];
      if (Buffer.byteLength(this.indexText(next), "utf8") > INDEX_MAX_BYTES) break;
      lines.push(next[next.length - 1]!);
      entries.push(skill);
    }
    return { revision: revisionOf(composed.skills, composed.assigned), entries, text: this.indexText(lines) };
  }

  private guidance(count: number): string {
    return count > 0
      ? "\n\nThese are app-managed guides. Call read_skill with a guide's exact name to read its full contents when a task matches; the project and provider instructions stay authoritative."
      : "";
  }

  private indexText(lines: readonly string[]): string {
    if (!lines.length) return "No app-managed guides are enabled for this request.";
    return `Enabled app-managed guides:${this.guidance(lines.length)}\n${lines.join("\n")}`;
  }

  save(botId: string, input: SaveSkillInput, expectedRevision?: string, actor?: ColonieSkillActor): ColonieSkillsView {
    if (!isSkillName(input.name)) {
      throw fail("Choose a name of lowercase letters, numbers and single hyphens.", 400);
    }
    const description = input.description.trim();
    if (!description) throw fail("Add a short description of when to use this guide.", 400);
    if (description.length > DESCRIPTION_MAX) throw fail(`The description is limited to ${DESCRIPTION_MAX} characters.`, 400);
    const instructions = input.instructions.trim();
    if (!instructions) throw fail("Add the guide instructions.", 400);
    scrub(instructions, "instructions");
    scrub(description, "description");

    const existing = listSkills(botId).find((skill) => skill.name === input.name);
    if (existing && !existing.editable) {
      throw fail(
        `The guide "${input.name}" was imported and is read-only. Create a copy with a new name to edit it.`,
        409,
      );
    }
    this.assertRevision(botId, expectedRevision);
    this.assertMutable(botId, !existing, actor);
    if (existing && input.expectedSha256 && existing.sha256 !== input.expectedSha256) {
      throw fail("This guide changed since you opened it. Re-read it and try again.", 409);
    }

    const skillMd = buildSkillMd(input.name, description, instructions);
    const staged = stageSkillWrite(botId, {
      action: existing ? "update" : "create",
      ...(existing ? { targetName: input.name } : {}),
      files: [{ path: "SKILL.md", content: skillMd }],
      source: COLONIE_SOURCE,
    });
    if ("error" in staged) throw fail(staged.error, 400);
    const applied = applyStagedSkillWrite(botId, staged.id, { expectedSha256: staged.sha256 });
    if ("error" in applied) throw fail(applied.error, 409);
    if (applied.enabled !== input.enabled) {
      const toggled = setSkillEnabled(botId, input.name, input.enabled);
      if ("error" in toggled) throw fail(toggled.error, 409);
    }
    return this.view(botId);
  }

  setEnabled(botId: string, name: string, enabled: boolean, expectedRevision: string): ColonieSkillsView {
    const skill = this.compose(botId).skills.find((entry) => entry.name === name);
    if (!skill) throw fail(`No guide named "${name}".`, 404);
    if (skill.origin === "library") {
      throw fail("Shared library guides are enabled in Settings → Skills, or assign one to use it here.", 400);
    }
    this.assertRevision(botId, expectedRevision);
    this.assertMutable(botId, false);
    const result = setSkillEnabled(botId, name, enabled);
    if ("error" in result) throw fail(result.error, 409);
    return this.view(botId);
  }

  remove(botId: string, name: string, expectedRevision: string): ColonieSkillsView {
    const skill = this.compose(botId).skills.find((entry) => entry.name === name);
    if (!skill) throw fail(`No guide named "${name}".`, 404);
    if (skill.origin === "library") {
      throw fail("Shared library guides cannot be deleted here. Unassign it from this bot instead.", 400);
    }
    this.assertRevision(botId, expectedRevision);
    this.assertMutable(botId, false);
    const result = removeSkill(botId, name);
    if ("error" in result) throw fail(result.error, 409);
    return this.view(botId);
  }

  assign(botId: string, names: readonly string[], expectedRevision: string): ColonieSkillsView {
    const known = new Set(listLibrarySkills().map((skill) => skill.name));
    for (const name of names) {
      if (!isSkillName(name) || !known.has(name)) {
        throw fail(`"${name}" is not a library guide.`, 422);
      }
    }
    this.assertRevision(botId, expectedRevision);
    this.assertMutable(botId, false);
    this.deps.setAssigned(botId, [...new Set(names)]);
    return this.view(botId);
  }

  /** Bounded async source import. Rechecks the bot and revision after the
   * await so a delete or an edit mid-fetch wins; fetched guides land disabled
   * for review. `text` carries a pasted SKILL.md instead of a URL. */
  async importSource(
    botId: string,
    source: string,
    expectedRevision: string,
    text?: string,
  ): Promise<ColonieSkillsView> {
    this.assertRevision(botId, expectedRevision);
    this.assertMutable(botId, false);
    const preRevision = this.view(botId).revision;

    let fetched: Array<{ source: string; files: Array<{ path: string; content: string }> }>;
    if (text !== undefined) {
      fetched = [{ source: source.trim() || "pasted:SKILL.md", files: [{ path: "SKILL.md", content: text }] }];
    } else {
      const result = await fetchSkillFromSource(source);
      if ("error" in result) throw fail(result.error, 400);
      fetched = result.skills;
    }

    if (!this.deps.bot(botId)) throw fail("No such bot", 404);
    if (this.view(botId).revision !== preRevision) {
      throw fail("These guides changed while importing. Refresh and try again.", 409);
    }
    this.assertMutable(botId, false);

    let imported = 0;
    let firstError = "";
    for (const skill of fetched) {
      const result = installSkill(botId, skill.source, skill.files);
      if ("error" in result) {
        if (!firstError) firstError = result.error;
      } else {
        imported += 1;
      }
    }
    if (imported === 0) throw fail(firstError || "No SKILL.md was found at that source.", 400);
    return this.view(botId);
  }
}