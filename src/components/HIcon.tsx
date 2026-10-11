// One wrapper for HugeIcons, so the migration reads the same at every call
// site: <HIcon icon={SomeIcon} size={16} className="..." />.
//
// HugeIcons renders through <HugeiconsIcon> with icons from
// @hugeicons/core-free-icons (Stroke Rounded, MIT). The defaults mirror
// Lucide: currentColor strokes and a 2-unit stroke so swapped glyphs keep
// their visual weight. Any other SVG prop (className, aria-hidden, role,
// data-testid, …) passes straight through to the <svg>.
import type { SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export type { IconSvgElement as HIconElement };

export function HIcon({
  icon,
  size = 16,
  strokeWidth = 2,
  ...rest
}: {
  icon: IconSvgElement;
  size?: number | string;
  strokeWidth?: number;
} & SVGProps<SVGSVGElement>) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} {...rest} />;
}
