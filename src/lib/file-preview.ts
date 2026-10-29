/** Preview only known formats; a file extension never grants access to a file. */
export type FilePreviewKind = "markdown" | "text" | "pdf" | "docx" | "image";

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
};
const TEXT_EXTENSIONS = new Set("txt log json jsonc jsonl ndjson yaml yml toml ini conf config csv tsv xml css scss sass less js jsx mjs cjs ts tsx mts cts py pyi rb go rs swift kt kts java c h cc cpp hpp cs php sh bash zsh fish sql graphql gql vue svelte r lua ex exs erl hs clj dart diff patch properties lock".split(" "));

export function previewFilename(path: string): string {
  const source = path.split(/[?#]/, 1)[0] ?? path;
  let decoded = source;
  try { decoded = decodeURIComponent(source); } catch { /* Keep malformed references inert at the server. */ }
  return decoded.split(/[\\/]/).at(-1) ?? decoded;
}

export function filePreviewKind(path: string): FilePreviewKind | null {
  const name = previewFilename(path).toLowerCase();
  const extension = name.split(".").at(-1) ?? "";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "pdf" || extension === "docx") return extension;
  if (Object.hasOwn(IMAGE_MIMES, extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension) || /^(dockerfile|makefile|license|readme|\.gitignore|\.gitattributes|\.editorconfig)(\.|$)/.test(name)) return "text";
  return null;
}

export function previewImageMime(path: string): string {
  return IMAGE_MIMES[previewFilename(path).split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export const TEXT_PREVIEW_MAX_BYTES = 1_000_000;
export const DOCUMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Enforce the limit on streamed bytes too; headers may be absent or incorrect. */
export async function readPreviewBytes(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) { await response.body?.cancel(); throw new Error("load"); }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new Error("size");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("format");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("size");
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function decodePreviewText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("format");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("format"); }
}
