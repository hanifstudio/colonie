// Conversation metadata and execution intents share the transcript database.
// Only this repository writes these tables; providers and broadcasts run after commit.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { withMessageTransaction } from "./message-db.ts";

export interface ConversationWork {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  botId: string;
  text: string;
  asker: string;
  askerKey: string;
  depth: number;
  upcoming: string[];
  visited?: string[];
  by?: string;
  /** A message that named no one, answered by the group's lead or every bot. */
  unnamed?: boolean;
  status: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  threadId?: string;
  messageId?: string;
  since?: number;
  about?: string;
}

function repository<T>(use: (db: DatabaseSync) => T): T {
  return withMessageTransaction((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_records (id TEXT PRIMARY KEY, document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversation_imports (file TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS conversation_work (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
          bot_id TEXT NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL,
          UNIQUE(conversation_id, source_message_id, bot_id)
        );
        CREATE INDEX IF NOT EXISTS conversation_work_status ON conversation_work(conversation_id, status);
      `);
    return use(db);
  });
}

/** Import once, leaving the old file untouched. A bad legacy file is never an empty workspace. */
export function loadConversationRecords<T extends { id: string }>(file: string): T[] {
  return repository((db) => {
    if (!db.prepare("SELECT file FROM conversation_imports WHERE file = ?").get(file)) {
      let legacy: unknown = [];
      try { legacy = JSON.parse(readFileSync(file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Colonie could not import the existing conversations. The original file is unchanged.", { cause: error }); }
      if (!Array.isArray(legacy) || legacy.some((row) => !row || typeof row.id !== "string")) throw new Error("Colonie's existing conversation list is invalid. The original file is unchanged.");
      const put = db.prepare("INSERT INTO conversation_records(id, document) VALUES (?, ?) ON CONFLICT(id) DO NOTHING");
      for (const row of legacy) put.run(row.id, JSON.stringify(row));
      db.prepare("INSERT INTO conversation_imports(file) VALUES (?)").run(file);
    }
    return (db.prepare("SELECT document FROM conversation_records ORDER BY rowid").all() as Array<{ document: string }>).map((row) => JSON.parse(row.document) as T);
  });
}

export function saveConversationRecords(records: readonly { id: string }[]): void {
  repository((db) => {
    const put = db.prepare("INSERT INTO conversation_records(id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document");
    for (const record of records) put.run(record.id, JSON.stringify(record));
  });
}

/** Remove a conversation and its execution intents from the durable index. */
export function deleteConversationRecord(id: string): void {
  repository((db) => {
    db.prepare("DELETE FROM conversation_work WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM conversation_records WHERE id = ?").run(id);
    db.prepare("DELETE FROM command_receipts WHERE kind = 'conversation.message' AND json_extract(key, '$[0]') = ?").run(id);
    db.prepare("DELETE FROM command_receipts WHERE kind = 'conversation.bot-message' AND json_extract(key, '$[0]') = ?").run(id);
    db.prepare("DELETE FROM command_receipts WHERE kind = 'conversation.routine-result' AND json_extract(key, '$[0]') = ?").run(id);
  });
}

export function enqueueConversationWork(work: ConversationWork): ConversationWork {
  return repository((db) => {
    db.prepare("INSERT INTO conversation_work(id, conversation_id, source_message_id, bot_id, status, document) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, source_message_id, bot_id) DO NOTHING")
      .run(work.id, work.conversationId, work.sourceMessageId, work.botId, work.status, JSON.stringify(work));
    const row = db.prepare("SELECT document FROM conversation_work WHERE conversation_id = ? AND source_message_id = ? AND bot_id = ?").get(work.conversationId, work.sourceMessageId, work.botId) as { document: string };
    return JSON.parse(row.document) as ConversationWork;
  });
}

export function saveConversationWork(work: ConversationWork): void {
  repository((db) => {
    const changed = db.prepare("UPDATE conversation_work SET status = ?, document = ? WHERE id = ?").run(work.status, JSON.stringify(work), work.id);
    if (changed.changes !== 1) throw new Error("The conversation work no longer exists.");
  });
}

export function conversationWork(conversationId?: string, status?: ConversationWork["status"]): ConversationWork[] {
  return repository((db) => {
    const rows = db.prepare("SELECT document FROM conversation_work WHERE (? IS NULL OR conversation_id = ?) AND (? IS NULL OR status = ?) ORDER BY rowid")
      .all(conversationId ?? null, conversationId ?? null, status ?? null, status ?? null) as Array<{ document: string }>;
    return rows.map((row) => JSON.parse(row.document) as ConversationWork);
  });
}
