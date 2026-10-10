/** Composio can return HTTP/MCP success while an individual target tool failed. */
function failedBody(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(failedBody);
  if (value === null || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (body.successful === false || body.success === false) return true;
  return Object.values(body).some(failedBody);
}
export function toolResultFailed(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const response = value as { isError?: boolean; content?: Array<{ text?: string }> };
  return response.isError === true || response.content?.some((block) => {
    try { return failedBody(JSON.parse(block.text ?? "")); }
    catch { return false; }
  }) === true;
}
