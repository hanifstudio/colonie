// The Colonie cross-conversation memory contract, shared by the server and
// the renderer. Types only: no Node and no server imports, so the Memory
// section can import this from the browser bundle. The server owns the
// ledger (server/colonie/memory/ledger/store.ts); the renderer only reads views and
// posts explicit owner edits.

export type MemoryScope = "shared" | "bot";
export type MemoryKind = "preference" | "fact" | "decision";

/** Globalization policy, per scope: `shared` is the workspace-wide choice,
 * `bot` is one bot's own. `enabled` gates recall and capture; `automatic`
 * additionally gates capture (a person may keep memory but stop it learning). */
export interface MemoryPreferences {
  enabled: boolean;
  automatic: boolean;
}

/** Where an automatically captured entry came from. The quote is the exact
 * verbatim evidence from the user's own message, already secret-scrubbed. */
export interface MemorySource {
  botId: string;
  threadId: string;
  messageId: string;
  at: string;
  quote: string;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Present for "bot" scope only; shared entries are workspace-owned. */
  botId?: string;
  /** Stable fact identity for corrections and suppression. */
  key: string;
  text: string;
  kind: MemoryKind;
  createdAt: string;
  updatedAt: string;
  /** YYYY-MM-DD, the last day a temporary fact holds. */
  until?: string;
  origin: "automatic" | "person";
  source?: MemorySource;
}

export interface MemoryView {
  /** Monotonic counter, decimal string. Sent back as `expectedRevision`. */
  revision: string;
  app: MemoryPreferences;
  bot: MemoryPreferences;
  entries: MemoryEntry[];
  status: { pending: number; running: boolean; lastError?: string; lastCaptureAt?: string };
}

/** Exactly what a dispatch carries: the fresh bounded recall plus its
 * revision. Never instructions, never a stable pin. */
export interface AcpMemoryContext {
  revision: string;
  entries: MemoryEntry[];
  text: string;
}

/** What recall and capture read: active, unexpired entries for one bot. */
export interface MemorySnapshot {
  revision: string;
  app: MemoryPreferences;
  bot: MemoryPreferences;
  entries: MemoryEntry[];
}

/** One validated model proposal. `text`/`evidence` keep the user's language;
 * `evidence` is a verbatim substring of the admitted source message. */
export interface MemoryChange {
  action: "upsert" | "forget";
  scope: MemoryScope;
  kind: MemoryKind;
  key: string;
  text: string;
  evidence: string;
  confidence: number;
  /** Existing entry id being corrected or forgotten. */
  replaces?: string;
  until?: string;
}

/** One completed, successful, owner-driven turn admitted to capture. */
export interface CompletedMemoryTurn {
  botId: string;
  threadId: string;
  messageId: string;
  /** The user's own message text, secret-scrubbed. */
  text: string;
  /** ISO timestamp. */
  at: string;
  /** Who wrote it, when not the owner (see MemoryJob.speaker). */
  speaker?: string;
}