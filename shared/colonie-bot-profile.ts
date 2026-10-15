import { z } from "zod";
import { botAvatarCropSchema, platformBotAvatarUrlSchema } from "./bot-avatar.ts";
import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "./bot-profile.ts";
import { mascotBodySchema } from "./mascot-bodies.ts";

/** The existing profile editor's fields, stored inside one workspace. */
export const platformBotProfileSchema = z.object({
  title: z.string().max(BOT_PROFILE_LIMITS.title).refine(fitsOnOneLine).optional(),
  description: z.string().max(BOT_PROFILE_LIMITS.description).optional(),
  soul: z.string().refine((value) => new TextEncoder().encode(value).length <= BOT_PROFILE_LIMITS.soul).optional(),
  color: z.enum(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]).optional(),
  mascotExpression: z.enum(["idle", "happy", "curious", "drowsy", "working", "thinking", "listening", "sleeping", "suspicious", "proud"]).nullable().optional(),
  mascotBody: mascotBodySchema.nullable().optional(),
  avatarUrl: platformBotAvatarUrlSchema.nullable().optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  avatarZoom: z.number().finite().min(1).max(3).optional(),
  avatarFocusX: z.number().finite().min(0).max(1).optional(),
  avatarFocusY: z.number().finite().min(0).max(1).optional(),
}).strict();

export type PlatformBotProfile = z.infer<typeof platformBotProfileSchema>;
export const platformBotUpdateSchema = platformBotProfileSchema.extend({
  name: z.string().trim().min(1).max(BOT_PROFILE_LIMITS.name).refine(fitsOnOneLine).optional(),
  /** Kept for existing creation clients; new profile editors use description. */
  purpose: z.string().max(500).optional(),
}).strict();
export type PlatformBotUpdate = z.infer<typeof platformBotUpdateSchema>;
export const platformBotCreateSchema = platformBotUpdateSchema.extend({ name: platformBotUpdateSchema.shape.name.unwrap() });
export const PLATFORM_AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const PLATFORM_AVATAR_MAX_BODY_BYTES = Math.ceil(PLATFORM_AVATAR_MAX_BYTES * 4 / 3) + 1024;
