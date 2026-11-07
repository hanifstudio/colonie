/** Saving a file with news of how far it got, and a way to stop. The response is read in pieces, so a
 * big file is counted as it arrives (the length the server declared is the total when it gave one),
 * and stopping cancels the read instead of waiting for the end. */
export interface DownloadProgress { received: number; total: number }

export async function readDownload(
  response: Response,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<Blob> {
  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
  const type = response.headers.get("content-type") ?? "";
  const reader = response.body?.getReader();
  // no stream to count (a very old engine): take it whole and report it done
  if (!reader) { const whole = await response.blob(); onProgress({ received: whole.size, total: whole.size }); return whole; }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    onProgress({ received, total });
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(new Uint8Array(value));
      received += value.byteLength;
      onProgress({ received, total });
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return new Blob(chunks, { type });
}

/** Hand a finished download to the browser's save, under a name. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // Chromium may not consume a blob URL until after the click task ends.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
