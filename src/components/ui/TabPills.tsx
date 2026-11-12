import type { ReactNode } from "react";
import { HIcon, type HIconElement } from "../HIcon";
import { cn } from "@/lib/cn";

export interface TabPill<Id extends string> {
  id: Id;
  label: string;
  icon: HIconElement;
  /** A marker after the label, such as a StatusDot. */
  after?: ReactNode;
  /** The guided tour's anchor on this tab. */
  tour?: string;
}

/** The pill-shaped tab row used at the top of a panel: one tab is pressed, a click picks another. */
export function TabPills<Id extends string>({ label, tabs, value, onChange, tour }: {
  label: string; tabs: Array<TabPill<Id>>; value: Id; onChange: (id: Id) => void; tour?: string;
}) {
  return (
    <div className="flex gap-0.5 rounded-full bg-inset p-0.5" aria-label={label} data-tour={tour}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" data-tour={tab.tour} aria-pressed={value === tab.id} onClick={() => onChange(tab.id)}
          className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors", value === tab.id ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>
          <HIcon icon={tab.icon} size={13} /> {tab.label}{tab.after}
        </button>
      ))}
    </div>
  );
}
