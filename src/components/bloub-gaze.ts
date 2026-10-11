import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared foundation for Bloub pointer-gaze.
 *
 * Historically each avatar only felt the pointer while it was directly above
 * its own small box (`onPointerMove` on the wrapping span). These helpers let
 * the *active* bot follow the pointer anywhere in the window instead, without
 * waking every idle row in the sidebar.
 *
 * Rules of the foundation:
 * - Only avatars mounted with `followGlobalPointer` (the selected sidebar row
 *   and the empty-chat hero) subscribe. Everything else keeps the old,
 *   fully-static idle rendering, so idle CPU stays bounded.
 * - One rAF-throttled `pointermove` listener per follower (at most two on
 *   screen for the same bot). Touch pointers are ignored; the gaze is a
 *   mouse/pen delight, not a touch interaction.
 * - Deflection saturates at the same maxima as the hover path, so a far-away
 *   cursor pulls the eyes to the edge but never further ("no juling").
 * - `prefers-reduced-motion`, window blur and leaving the window all rest the
 *   eyes via `onRest`.
 */

/** Same maxima as the local hover path in `BloubAvatar`. */
export const BLOUB_GAZE_MAX_YAW = 40;
export const BLOUB_GAZE_MAX_PITCH = 25;

/** Pointer distance in px at which the gaze saturates at its maximum. */
export const BLOUB_GAZE_SOFT_RADIUS_PX = 320;

/**
 * Camera framing for Bloub frames. The engine draws on a ±158 viewBox because
 * orbit rings and comet swooshes reach ~155 units, but the resting body never
 * exceeds ~105 (locked by `bloub-frame-fit.test.ts`). Showing the tight
 * window whenever no decor arc is visibly drawn makes the body ~1.3x larger
 * on screen without touching any engine geometry — a pure camera change.
 */
export const BLOUB_TIGHT_HALF = 120;
export const BLOUB_FULL_HALF = 158;
/** Arc opacity at or below this counts as invisible (float dust, not decor). */
export const BLOUB_ARC_VISIBLE_EPS = 0.02;

/** Half-side of the square viewBox a frame needs: tight at rest, full for decor. */
export function bloubViewHalf(arcs: ReadonlyArray<{ opacity: number }>): number {
  return arcs.some((arc) => arc.opacity > BLOUB_ARC_VISIBLE_EPS)
    ? BLOUB_FULL_HALF
    : BLOUB_TIGHT_HALF;
}

export function bloubLookForPointer({
  centerX,
  centerY,
  clientX,
  clientY,
  maxYaw = BLOUB_GAZE_MAX_YAW,
  maxPitch = BLOUB_GAZE_MAX_PITCH,
  radiusPx = BLOUB_GAZE_SOFT_RADIUS_PX,
}: {
  centerX: number;
  centerY: number;
  clientX: number;
  clientY: number;
  maxYaw?: number;
  maxPitch?: number;
  radiusPx?: number;
}): { yaw: number; pitch: number } {
  const radius = radiusPx > 0 ? radiusPx : BLOUB_GAZE_SOFT_RADIUS_PX;
  const nx = Math.max(-1, Math.min(1, (clientX - centerX) / radius));
  const ny = Math.max(-1, Math.min(1, (clientY - centerY) / radius));
  // Screen y grows downward, but the engine reads a POSITIVE pitch as "look
  // up" (face.ts: forward tips toward up). So a pointer below the avatar
  // (ny > 0) must look DOWN, i.e. a negative pitch — hence the negation.
  // `|| 0` normalises the -0 that `-0 * maxPitch` would otherwise produce.
  return { yaw: nx * maxYaw, pitch: -ny * maxPitch || 0 };
}

export function useGlobalBloubGaze({
  enabled,
  elementRef,
  onGaze,
  onRest,
}: {
  enabled: boolean;
  elementRef: RefObject<HTMLSpanElement | null>;
  onGaze: (yaw: number, pitch: number) => void;
  onRest: () => void;
}): void {
  const saved = useRef({ onGaze, onRest });
  saved.current = { onGaze, onRest };
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    const flush = () => {
      raf = 0;
      if (!pending) return;
      const target = elementRef.current;
      const point = pending;
      pending = null;
      if (!target) return;
      const box = target.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const { yaw, pitch } = bloubLookForPointer({
        centerX: box.left + box.width / 2,
        centerY: box.top + box.height / 2,
        clientX: point.x,
        clientY: point.y,
      });
      saved.current.onGaze(yaw, pitch);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pending = { x: event.clientX, y: event.clientY };
      if (!raf) raf = window.requestAnimationFrame(flush);
    };
    const rest = () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      pending = null;
      saved.current.onRest();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("mouseleave", rest);
    window.addEventListener("blur", rest);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("mouseleave", rest);
      window.removeEventListener("blur", rest);
      saved.current.onRest();
    };
  }, [enabled, elementRef]);
}
