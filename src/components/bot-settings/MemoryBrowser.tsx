// The memory list, kept calm however long it grows: a count, a search box, and
// the memories grouped by kind with only the first few of each shown. Each
// row's Edit and Forget appear on hover or focus, and always on touch screens.
import { Delete02Icon, NoteEditIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";

import { cn } from "@/lib/cn";
import type { MemoryEntry, MemoryKind } from "../../../shared/colonie-memory";
import { HIcon } from "../HIcon";
import { Button } from "../ui/Button";
import { EmptyCard } from "../ui/EmptyCard";
import { inputCls } from "./field";

const KIND_GROUPS: ReadonlyArray<{ kind: MemoryKind; label: string }> = [
  { kind: "preference", label: "Preferences" },
  { kind: "fact", label: "Facts" },
  { kind: "decision", label: "Decisions" },
];

/** How many memories a group shows before "Show all". */
export const MEMORY_GROUP_PREVIEW = 5;

export function matchesMemory(entry: MemoryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || entry.text.toLowerCase().includes(needle);
}

const memoryCount = (n: number) => `${n} ${n === 1 ? "memory" : "memories"}`;

export function MemoryBrowser({ entries, botName, caption, onEdit, onForget }: {
  entries: readonly MemoryEntry[];
  botName: string;
  /** The small line under a memory: where it came from. */
  caption: (entry: MemoryEntry) => string;
  onEdit: (entry: MemoryEntry) => void;
  onForget: (entry: MemoryEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Partial<Record<MemoryKind, boolean>>>({});
  if (entries.length === 0) {
    return (
      <EmptyCard
        label="Memories"
        icon={<HIcon icon={SparklesIcon} size={22} />}
        title="Nothing remembered yet"
        body={`As you talk, ${botName} will remember useful details here. You can also add one yourself.`}
      />
    );
  }
  const shown = entries.filter((entry) => matchesMemory(entry, query));
  const searching = query.trim() !== "";
  return (
    <div className="flex flex-col gap-3">
      <div className="px-1 text-[13px] text-ink-secondary" aria-live="polite">
        {searching ? `${shown.length} of ${memoryCount(entries.length)}` : memoryCount(entries.length)}
      </div>
      <input
        type="search"
        aria-label="Search memories"
        placeholder="Search memories"
        className={cn(inputCls, "text-[13px]")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length === 0 && <p className="px-1 text-[13px] text-ink-secondary">No memories match &ldquo;{query.trim()}&rdquo;.</p>}
      {KIND_GROUPS.map(({ kind, label }) => {
        const group = shown.filter((entry) => entry.kind === kind);
        if (group.length === 0) return null;
        const expanded = open[kind] === true;
        const visible = expanded ? group : group.slice(0, MEMORY_GROUP_PREVIEW);
        return (
          <section key={kind} aria-label={label} className="rounded-xl bg-card p-3">
            <h4 className="px-1 text-[12px] font-medium text-ink-secondary">{label} <span className="text-ink-tertiary">{group.length}</span></h4>
            <ul className="mt-2 flex flex-col gap-1.5">
              {visible.map((entry) => (
                <li key={entry.id} className="group flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug text-ink">{entry.text}</div>
                    <div className="mt-0.5 text-[11px] text-ink-tertiary">{caption(entry)}</div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100">
                    <Button size="sm" className="px-1.5" title="Edit" onClick={() => onEdit(entry)} aria-label={`Edit memory: ${entry.text}`}>
                      <HIcon icon={NoteEditIcon} size={13} />
                    </Button>
                    <Button size="sm" className="px-1.5 text-danger" title="Forget" onClick={() => onForget(entry)} aria-label={`Forget memory: ${entry.text}`}>
                      <HIcon icon={Delete02Icon} size={13} />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            {group.length > MEMORY_GROUP_PREVIEW && (
              <Button variant="quiet" size="sm" className="ml-1 mt-2" aria-expanded={expanded} onClick={() => setOpen({ ...open, [kind]: !expanded })}>
                {expanded ? "Show fewer" : `Show all ${group.length}`}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}
