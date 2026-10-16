/** Prepared sessions are not proof that an agent owns the visible history. */
export function nativeHistoryConflict(input: {
  hasUserHistory: boolean;
  selectedInstanceId: string;
  lastInstanceId?: string;
  cursors: Record<string, unknown>;
}): boolean {
  if (!input.hasUserHistory) return false;
  if (input.lastInstanceId !== undefined) {
    return input.lastInstanceId !== input.selectedInstanceId || typeof input.cursors[input.selectedInstanceId] !== "string";
  }
  const ids = Object.keys(input.cursors);
  // A failed first setup with no native context may be retried. Old records
  // with context must have exactly one unambiguous native owner.
  return ids.length > 0 && (ids.length !== 1 || typeof input.cursors[input.selectedInstanceId] !== "string");
}
