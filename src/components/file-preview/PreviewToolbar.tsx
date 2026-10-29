import { Add01Icon, MinusSignIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";

export const PREVIEW_ACTION = "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-35";

export function PreviewToolbar({ zoom, fitZoom = 1, onZoom, children }: {
  zoom: number | null; fitZoom?: number; onZoom: (zoom: number | null) => void; children?: React.ReactNode;
}) {
  const scale = zoom ?? fitZoom;
  return <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-hairline/30 px-3 text-[11px] text-ink-secondary">
    <span className="min-w-0 truncate">{children}</span>
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" className={PREVIEW_ACTION} title="Zoom out" aria-label="Zoom out" disabled={scale <= 0.25} onClick={() => onZoom(Math.max(0.25, scale - 0.25))}><HIcon icon={MinusSignIcon} size={14} /></button>
      <button type="button" className="min-w-16 rounded-md px-2 py-1.5 text-[11px] hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" title="Fit to width" aria-label="Fit to width" onClick={() => onZoom(null)}>{zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}</button>
      <button type="button" className={PREVIEW_ACTION} title="Zoom in" aria-label="Zoom in" disabled={scale >= 3} onClick={() => onZoom(Math.min(3, scale + 0.25))}><HIcon icon={Add01Icon} size={14} /></button>
    </div>
  </div>;
}
