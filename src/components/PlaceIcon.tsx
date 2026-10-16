import type { ComponentProps } from "react";
import {
  BoxIcon,
  GlobeIcon,
  MonitorIcon,
  PowerIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HIcon } from "./HIcon";
import type { EffectivePlace } from "@/lib/place";

/** The same icon for a place everywhere: picker, chip, tab, tool row. */
const ICONS = { vm: BoxIcon, local: MonitorIcon, browser: GlobeIcon, auto: SparklesIcon, off: PowerIcon } as const satisfies Record<EffectivePlace, IconSvgElement>;

export function PlaceIcon({ place, ...props }: { place: EffectivePlace } & Omit<ComponentProps<typeof HIcon>, "icon">) {
  return <HIcon icon={ICONS[place]} {...props} />;
}