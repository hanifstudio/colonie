import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Delete02Icon, ImageAdd01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";

import type { Bot } from "@/state/store";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import {
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import {
  AVATAR_FOCUS_CENTER,
  AVATAR_ZOOM_MAX,
  AVATAR_ZOOM_MIN,
  botAvatarUrlFromStoredPath,
  clampAvatarFocus,
  clampAvatarZoom,
} from "../../shared/bot-avatar";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";
import { PICKABLE_BODY_IDS, bodyChoice } from "./BloubAvatar";
import { BotAvatar, MausAvatar } from "./Avatar";

type AvatarPatch = Partial<
  Pick<Bot, "avatarCrop" | "avatarUrl" | "avatarZoom" | "avatarFocusX" | "avatarFocusY" | "color" | "mascotBody">
>;

const FRAME_SIZE = 168;

function AvatarFraming({
  bot,
  disabled,
  onPatch,
}: {
  bot: Bot;
  disabled: boolean;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const zoom = clampAvatarZoom(bot.avatarZoom ?? AVATAR_ZOOM_MIN);
  const focusX = clampAvatarFocus(bot.avatarFocusX ?? AVATAR_FOCUS_CENTER);
  const focusY = clampAvatarFocus(bot.avatarFocusY ?? AVATAR_FOCUS_CENTER);
  const framed = zoom !== AVATAR_ZOOM_MIN || focusX !== AVATAR_FOCUS_CENTER || focusY !== AVATAR_FOCUS_CENTER;
  const drag = useRef<{ x: number; y: number; focusX: number; focusY: number; pointer: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, focusX, focusY, pointer: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.pointer) return;
    onPatch({
      avatarFocusX: clampAvatarFocus(start.focusX - (event.clientX - start.x) / FRAME_SIZE / zoom),
      avatarFocusY: clampAvatarFocus(start.focusY - (event.clientY - start.y) / FRAME_SIZE / zoom),
    });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (disabled || event.deltaY === 0) return;
    event.preventDefault();
    onPatch({ avatarZoom: clampAvatarZoom(zoom + (event.deltaY < 0 ? 0.08 : -0.08)) });
  };

  return (
    <div className="py-3">
      <div
        className="mx-auto w-fit cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <BotAvatar bot={bot} size={FRAME_SIZE} animated={false} label={`${bot.name} avatar preview`} />
      </div>
      <div className="mb-1.5 mt-4 flex items-baseline justify-between">
        <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Zoom</span>
        <span className="tabular-nums text-[12px] text-ink-secondary">{Math.round(zoom * 100)}%</span>
      </div>
      <input
        type="range"
        min={AVATAR_ZOOM_MIN}
        max={AVATAR_ZOOM_MAX}
        step={0.01}
        value={zoom}
        disabled={disabled}
        aria-label="Zoom avatar"
        aria-valuemin={AVATAR_ZOOM_MIN}
        aria-valuemax={AVATAR_ZOOM_MAX}
        aria-valuenow={zoom}
        aria-valuetext={`${Math.round(zoom * 100)}%`}
        onChange={(event) => onPatch({ avatarZoom: clampAvatarZoom(Number(event.target.value)) })}
        className="w-full accent-accent"
      />
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[11.5px] text-ink-secondary">
        <span>Drag the picture to reposition it. Scroll to zoom.</span>
        {framed && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPatch({ avatarZoom: AVATAR_ZOOM_MIN, avatarFocusX: AVATAR_FOCUS_CENTER, avatarFocusY: AVATAR_FOCUS_CENTER })}
            className="shrink-0 rounded-md px-2 py-1 text-ink hover:bg-control disabled:opacity-50"
          >
            Reset framing
          </button>
        )}
      </div>
    </div>
  );
}

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
  compact = false,
}: {
  bot: Bot;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
  /** Tighter spacing and smaller pictures, for a form where the avatar is not the main thing. */
  compact?: boolean;
}) {
  const { uploadAvatar, readOnly } = useBotEditor();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crop = bot.avatarCrop ?? "mascot";
  const hasImage = crop !== "mascot" && Boolean(bot.avatarUrl);
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const busy = uploading || Boolean(readOnly);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setUploading(true);
    setError(null);
    try {
      const saved = uploadAvatar ? null : await imageAttachmentFromFile(file);
      const avatarUrl = uploadAvatar ? await uploadAvatar(file) : saved ? botAvatarUrlFromStoredPath(saved.path) : null;
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      const latestCrop = cropRef.current;
      onPatch({
        avatarUrl,
        avatarCrop: latestCrop === "mascot" ? "circle" : latestCrop,
        avatarZoom: AVATAR_ZOOM_MIN,
        avatarFocusX: AVATAR_FOCUS_CENTER,
        avatarFocusY: AVATAR_FOCUS_CENTER,
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeImage = () => {
    setError(null);
    onPatch({
      avatarUrl: null,
      avatarCrop: "mascot",
      avatarZoom: AVATAR_ZOOM_MIN,
      avatarFocusX: AVATAR_FOCUS_CENTER,
      avatarFocusY: AVATAR_FOCUS_CENTER,
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="rounded-lg bg-control px-3 py-1.5 text-[14px] font-medium text-ink">Avatar</span>
        <button
          disabled={busy}
          onClick={() => onPatch({ avatarCrop: "mascot", color: "green", mascotBody: "cursor" })}
          className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
        >
          Reset mascot
        </button>
      </div>

      <div className="p-3">
        {hasImage ? (
          <AvatarFraming bot={bot} disabled={busy} onPatch={onPatch} />
        ) : (
          <div className={cn("flex justify-center", compact ? "py-1" : "py-3")}>
            <BotAvatar
              bot={bot}
              state={activeState}
              size={compact ? 72 : 112}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <HIcon icon={Loading02Icon} size={14} className="animate-spin" /> : <HIcon icon={ImageAdd01Icon} size={14} />}
            Upload image
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={busy}
              aria-label="Remove custom avatar image"
              title="Remove custom image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
            >
              <HIcon icon={Delete02Icon} size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">PNG, JPEG, GIF, or WebP · up to 10 MB</div>

        {!hasImage && (
          <>
            <div className={cn("mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary", compact ? "mt-3" : "mt-4")}>
              Body
            </div>
            <div className="grid grid-cols-4 gap-2">
              {PICKABLE_BODY_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={busy}
                  aria-pressed={bodyChoice(bot.mascotBody) === id}
                  aria-label={`Use the ${MASCOT_BODIES[id].name} body`}
                  onClick={() => onPatch({ mascotBody: id })}
                  className={cn(
                    "flex items-center justify-center rounded-xl disabled:opacity-50", compact ? "py-1.5" : "py-3",
                    bodyChoice(bot.mascotBody) === id
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60",
                  )}
                >
                  <MausAvatar color={bot.color} bodyId={id} size={compact ? 36 : 52} animated={false} trackPointer={false} />
                </button>
              ))}
            </div>

            <div className={cn("mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary", compact ? "mt-3" : "mt-4")}>
              Color
            </div>
            <div className="flex flex-wrap gap-2">
              {MAUS_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={busy}
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn(
                    "size-6 rounded-full border-2 border-transparent transition-transform hover:scale-110 disabled:opacity-50",
                    bot.color === color && "ring-2 ring-accent-border ring-offset-1 ring-offset-card",
                  )}
                  style={{ backgroundColor: MAUS_COLORS[color] }}
                  title={color}
                  aria-label={`Use ${color} mascot color`}
                />
              ))}
            </div>
          </>
        )}

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}
