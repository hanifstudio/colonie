import { redactSecretsInText } from "../redact.ts";

/**
 * The engines' own account of why a turn failed. Both maintained adapters
 * (Claude and Codex) name the failure ("quota exhausted", "rate limited",
 * "context full", "sign in again") in `_meta.jetbrains.air.sessionFailure` when
 * the client says it understands it. Reading that is more dependable than
 * matching the provider's wording, and the adapters keep it up to date.
 */
export const SESSION_FAILURE_CLIENT_META = { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } };

export interface SessionFailure {
  kind: string;
  /** What to tell the person: the adapter's title, then its details. */
  text: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The failure an adapter reported in this `_meta`, or undefined. A warning
 * (an advisory the turn survived) is not a failure. */
export function sessionFailureOf(meta: unknown): SessionFailure | undefined {
  const failure = asRecord(asRecord(asRecord(asRecord(meta).jetbrains).air).sessionFailure);
  const title = typeof failure.title === "string" ? failure.title.trim() : "";
  if (!title || failure.severity === "warning") return undefined;
  const details = typeof failure.details === "string" ? failure.details.trim() : "";
  const text = details && details !== title ? `${title} ${details}` : title;
  return {
    kind: typeof failure.kind === "string" ? failure.kind : typeof failure.category === "string" ? failure.category : "unknown",
    text: redactSecretsInText(text).slice(0, 600),
  };
}
