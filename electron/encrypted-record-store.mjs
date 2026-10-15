// The encrypted, atomic, serialized record a sign-in is kept in: today the
// Cloud account grant. Reading is strict — a record that is not a small
// regular file, one this computer's key no longer opens (Windows after a
// reinstall onto a new profile), or one that is not JSON is reported as
// unreadable so the caller can forget it and ask again. A locked keychain is
// never that: the same record is read again later.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** A saved record that can never be read. Removing it loses nothing. */
export const unreadableRecord = error => error?.code === "unreadable_record";
const unreadable = message => Object.assign(new Error(message), { code: "unreadable_record" });
/** The wait before try `attempt` (1, 2, 3...) after a failure: 15 s, 30 s, then every minute. */
export const retryDelay = attempt => [15_000, 30_000, 60_000][Math.min(attempt, 3) - 1];

const decryptedText = decrypted => (typeof decrypted === "string" ? decrypted : decrypted?.result);

export function createEncryptedRecordStore({ file, encryption, label = "saved record" }) {
  let tail = Promise.resolve();
  const available = async () => {
    if (!(await encryption.available())) throw new Error("Unlock your system keychain before connecting.");
  };
  return {
    async read() {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 64 * 1024) throw unreadable(`Invalid ${label}.`);
        await available();
        const encrypted = await handle.readFile();
        let text;
        try { text = decryptedText(await encryption.decrypt(encrypted)); } catch { throw unreadable("This computer can no longer decrypt the record."); }
        // An answer in a shape this app does not know is this app's mistake, never the record's.
        if (typeof text !== "string") throw new Error("Unexpected decrypt result.");
        try { return JSON.parse(text); } catch { throw unreadable("The record is not JSON."); }
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw Object.assign(new Error(`Your ${label} could not be read. Unlock your system keychain and try again.`),
          unreadableRecord(error) ? { code: error.code } : {});
      }
      finally { await handle?.close(); }
    },
    write(value) {
      const operation = tail.catch(() => {}).then(async () => {
        // Forgetting a capability must work even while the keychain is locked.
        // This exact owned file is removed in the same queue as pending writes.
        if (value === null) {
          try { await fs.unlink(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
          return;
        }
        await available();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const encrypted = await encryption.encrypt(JSON.stringify(value));
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      tail = operation;
      return operation;
    },
  };
}