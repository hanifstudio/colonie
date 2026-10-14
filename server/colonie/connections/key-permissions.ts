/** Provider validation errors should explain the permission the key needs.
 * A failed provider validation is distinct from an encrypted-store failure. */
export function composioKeyRejection(details: string, status: number, apiKey?: string): Error {
  const safe = (apiKey ? details.replaceAll(apiKey, "[redacted key]") : details).slice(0, 500);
  if (/session_management/i.test(safe) && /write\s+access|write\s+permission|requires?[^.]*write/i.test(safe)) {
    return Object.assign(new Error("This Composio key cannot create sessions. In Composio, give the project key session_management Write access, then try saving it again."),
      { code: "composio_session_write_required", status: 422 });
  }
  return Object.assign(new Error(safe || `Composio rejected this key (HTTP ${status}).`), { code: "composio_key_rejected", status: 422 });
}
