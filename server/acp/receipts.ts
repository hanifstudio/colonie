import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../persistence/atomic.ts";
import type { AcpInputReceipt } from "../../shared/acp.ts";

function receiptPath(threadId: string): string {
  if (!/^[\w-]{1,128}$/.test(threadId)) throw new Error("Invalid thread id");
  return join(DATA_DIR, "acp-inputs", `${threadId}.json`);
}

export function inputReceipts(threadId: string): AcpInputReceipt[] {
  try {
    return JSON.parse(readFileSync(receiptPath(threadId), "utf8")) as AcpInputReceipt[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Save before dispatch, independent of normalized/redacted runtime logs. */
export function saveInputReceipt(receipt: AcpInputReceipt): void {
  const path = receiptPath(receipt.threadId);
  mkdirSync(join(DATA_DIR, "acp-inputs"), { recursive: true, mode: 0o700 });
  const previous = inputReceipts(receipt.threadId).filter((entry) => entry.id !== receipt.id);
  writeFileAtomic(path, JSON.stringify([...previous, receipt].slice(-50), null, 2), { mode: 0o600 });
}
