// The Colonie skills contract, shared by the server and the renderer. Types
// only: no Node and no server imports, so the Skills card can import this from
// the browser bundle. The server owns the service (server/colonie/skills/
// service.ts); the renderer posts explicit owner edits and reads fresh views.
//
// "private" is a guide the bot owns (created or imported into its own store);
// "library" is a shared guide the bot has been assigned. Private names shadow
// library names, so origin reflects what the bot actually reads.

export interface ColonieSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  sha256: string;
  /** Only user/Chief-authored learned guides can be edited in place. */
  editable: boolean;
  origin: "private" | "library";
  warnings: string[];
}

export interface ColonieSkillsView {
  /** Content-derived revision; sent back as `expectedRevision`. */
  revision: string;
  /** The bot's guides, private plus assigned library. */
  skills: ColonieSkill[];
  /** Library guides not yet assigned to this bot (the add-from-library pool). */
  library: ColonieSkill[];
  /** The authoritative assignment list, even when a private guide shadows a
   * same-named library entry. */
  assignedSkills: string[];
}

/** Exactly what a dispatch carries: the bounded named index plus its revision.
 * Never full bodies, never instructions, never a stable pin. */
export interface AcpSkillsContext {
  revision: string;
  entries: ColonieSkill[];
  text: string;
}

/** The review/read body for one guide. `text` is the exact SKILL.md, read
 * through the same integrity check that gates enablement. */
export interface ColonieSkillContent {
  skill: ColonieSkill;
  text: string;
}

/** A trusted backend actor (the Chief creating a guide for itself). Never an
 * HTTP body field. */
export interface ColonieSkillActor {
  botId: string;
}