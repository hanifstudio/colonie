// A person's photo, kept on their Colonie account so every workspace shows
// the same face. The page that sets it shrinks the picture in the browser to
// a small square JPEG first; this keeps only that, as base64 text (the same
// SQL in Neon and in tests). Anyone with the account's id (the `sub` every
// workspace already knows) can see the photo, like a profile picture.
import type { Db } from "./db.ts";

/** About a 256 px JPEG; anything larger was not made by the photo page. */
export const PHOTO_MAX_BASE64 = 200_000;
const DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

export async function savePhoto(db: Db, accountId: string, dataUrl: string, at: Date): Promise<"saved" | "invalid"> {
  const base64 = DATA_URL.exec(dataUrl)?.[1];
  if (!base64 || base64.length > PHOTO_MAX_BASE64) return "invalid";
  // a JPEG starts with FF D8 FF ("/9j/" in base64)
  if (!base64.startsWith("/9j/")) return "invalid";
  await db.query(
    `insert into colonie_cloud.photos (account_id, data, updated_at) values ($1, $2, $3)
     on conflict (account_id) do update set data = excluded.data, updated_at = excluded.updated_at`,
    [accountId, base64, at.toISOString()]);
  return "saved";
}

export async function removePhoto(db: Db, accountId: string): Promise<void> {
  await db.query("delete from colonie_cloud.photos where account_id = $1", [accountId]);
}

export async function findPhoto(db: Db, accountId: string): Promise<{ data: string; updatedAt: string } | null> {
  const [row] = await db.query<{ data: string; updated_at: string | Date }>(
    "select data, updated_at from colonie_cloud.photos where account_id = $1", [accountId]);
  return row ? { data: row.data, updatedAt: new Date(row.updated_at).toISOString() } : null;
}
