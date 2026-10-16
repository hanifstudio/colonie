import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";

const preferenceSchema = z.object({
  mode: z.string().optional(),
  approvalBaseline: z.string().optional(),
  values: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
}).strict();
const fileSchema = z.object({ version: z.literal(1), instances: z.record(z.string(), preferenceSchema) }).strict();
export type NativePreferences = z.infer<typeof preferenceSchema>;

function preferencePath(threadId: string) {
  if (!/^[\w-]{1,128}$/.test(threadId)) throw new Error("Invalid thread id");
  return join(DATA_DIR, "acp-settings", `${threadId}.json`);
}

function readPreferences(threadId: string): z.infer<typeof fileSchema> {
  try { return fileSchema.parse(JSON.parse(readFileSync(preferencePath(threadId), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, instances: {} }; throw error; }
}

export function nativePreferences(threadId: string, instanceId: string): NativePreferences {
  return readPreferences(threadId).instances[instanceId] ?? { values: {} };
}

export function saveNativePreferences(threadId: string, instanceId: string, preferences: NativePreferences) {
  const file = readPreferences(threadId);
  file.instances = { ...file.instances, [instanceId]: preferenceSchema.parse(preferences) };
  mkdirSync(join(DATA_DIR, "acp-settings"), { recursive: true, mode: 0o700 });
  writeFileAtomic(preferencePath(threadId), JSON.stringify(file, null, 2), { mode: 0o600 });
}

const identity = { sessionId: z.string().min(1), expectedRevision: z.string().min(1), threadId: z.string().regex(/^[\w-]{1,128}$/) };
export const nativeSettingChangeSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("mode"), value: z.string().min(1) }).strict(),
  z.object({ ...identity, kind: z.literal("option"), configId: z.string().min(1), value: z.union([z.string(), z.boolean()]) }).strict(),
]);
