// What bots with Memory upkeep added to the shared About me on their own.
// A durable fact about the person, taken from the person's own words, is
// appended to About me as a dated, attributed line — every bot then knows
// it — and recorded here so Settings can list it with a Remove button.
// A removed fact is remembered (by identity only) and never added again.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { factIdentity } from "./memory-entries.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_KEPT = 200;
const MAX_REMOVED = 500;
const TEXT_MAX = 300;

export interface LearnedFact {
  id: string;
  text: string;
  /** The exact line About me gained, so Remove takes out only that line. */
  line: string;
  botId: string;
  botName: string;
  at: number;
}

interface LearnedFile {
  learned: LearnedFact[];
  removed: string[];
}

/** A fact as the line About me gains: dated and attributed, like a memory entry. */
export function aboutMeLine(fact: { text: string; botName: string }, today: string): string {
  return `- ${today} · learned by ${fact.botName.replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, 60)} · ${fact.text}`;
}

/** The identity of an About me line, attributed or hand-written. */
function lineIdentity(line: string): string {
  return factIdentity(line.replace(/^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /, ""));
}

/** About me with the lines appended, or null when it would pass the limit. */
export function appendAboutMe(aboutMe: string, lines: readonly string[], maxChars = 24_000): string | null {
  if (!lines.length) return aboutMe;
  const base = aboutMe.replace(/\s+$/, "");
  const next = base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
  return next.length > maxChars ? null : next;
}

/** The facts bots learned, kept in one JSON file at `file`. The caller owns
 * where that is; this module never reads global config. */
export class LearnedFacts {
  private readonly file: string;
  constructor(file: string) { this.file = file; }

  private load(): LearnedFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LearnedFile>;
      const learned = Array.isArray(parsed.learned)
        ? parsed.learned.filter((f): f is LearnedFact =>
          Boolean(f) && typeof f.id === "string" && typeof f.text === "string" && typeof f.line === "string" && typeof f.botId === "string" && typeof f.botName === "string" && typeof f.at === "number")
        : [];
      const removed = Array.isArray(parsed.removed) ? parsed.removed.filter((r): r is string => typeof r === "string") : [];
      return { learned, removed };
    } catch {
      return { learned: [], removed: [] };
    }
  }

  private save(file: LearnedFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  /** Newest first, as Settings lists them. */
  list(): LearnedFact[] {
    return [...this.load().learned].reverse();
  }

  /** Facts not yet in About me and never removed by the person, as the lines
   * to append. Nothing is recorded until `commit`. */
  plan(from: { botId: string; botName: string }, texts: readonly string[], aboutMe: string, today: string, now = Date.now()): LearnedFact[] {
    const file = this.load();
    const known = new Set([...file.removed, ...aboutMe.split("\n").map(lineIdentity)]);
    const out: LearnedFact[] = [];
    for (const raw of texts) {
      const text = redactSecretsInText(raw.replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX);
      const key = factIdentity(text);
      if (!key || known.has(key)) continue;
      known.add(key);
      out.push({ id: randomUUID(), text, line: aboutMeLine({ text, botName: from.botName }, today), botId: from.botId, botName: from.botName, at: now });
    }
    return out;
  }

  commit(facts: readonly LearnedFact[]): void {
    if (!facts.length) return;
    const file = this.load();
    file.learned = [...file.learned, ...facts].slice(-MAX_KEPT);
    this.save(file);
  }

  /** Forget one learned fact: its line leaves About me (when it is still
   * there, unedited) and it is never added again. Save About me before
   * committing removal so a failed profile save leaves the fact retryable. */
  remove(id: string, aboutMe: string, saveAboutMe?: (text: string) => void): { fact: LearnedFact; aboutMe: string } | null {
    const file = this.load();
    const fact = file.learned.find((f) => f.id === id);
    if (!fact) return null;
    const lines = aboutMe.split("\n");
    const at = lines.indexOf(fact.line);
    if (at !== -1) lines.splice(at, 1);
    const next = lines.join("\n");
    if (next !== aboutMe) saveAboutMe?.(next);
    file.learned = file.learned.filter((f) => f.id !== id);
    file.removed = [...file.removed, factIdentity(fact.text)].slice(-MAX_REMOVED);
    this.save(file);
    return { fact, aboutMe: next };
  }
}
