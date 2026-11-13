// The memory list, kept simple however long it grows: one plain list of
// short lines, the first few shown, "Show all" for the rest, and a search box
// only once the list is long enough to need one. Edit and Forget appear on
// hover or focus, and always on touch screens. Where a memory came from is a
// tooltip, not a second line.
import { Delete02Icon, NoteEditIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";

import { cn } from "@/lib/cn";
import type { MemoryEntry } from "../../../shared/colonie-memory";
import { HIcon } from "../HIcon";
import { Button } from "../ui/Button";
import { EmptyCard } from "../ui/EmptyCard";
import { inputCls } from "./field";

/** How many memories show before "Show all"; search appears past this. */
export const MEMORY_PREVIEW = 8;

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
  const [expanded, setExpanded] = useState(false);
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
  const searching = query.trim() !== "";
  const shown = entries.filter((entry) => matchesMemory(entry, query));
  const visible = expanded || searching ? shown : shown.slice(0, MEMORY_PREVIEW);
  return (
    <div className="flex flex-col gap-2">
      {entries.length > MEMORY_PREVIEW && (
        <input
          type="search"
          aria-label="Search memories"
          placeholder={`Search ${memoryCount(entries.length)}`}
          className={cn(inputCls, "text-[13px]")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {shown.length === 0 && <p className="px-1 text-[13px] text-ink-secondary">No memories match &ldquo;{query.trim()}&rdquo;.</p>}
      <ul aria-label="Memories" className="flex flex-col">
        {visible.map((entry) => (
          <li key={entry.id} title={caption(entry)} className="group flex items-center gap-2 border-b border-edge py-2 last:border-b-0">
            <div className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{entry.text}</div>
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
      {!searching && shown.length > MEMORY_PREVIEW && (
        <Button variant="quiet" size="sm" className="self-start" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${shown.length}`}
        </Button>
      )}
    </div>
  );
}
