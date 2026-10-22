// A person's face: the photo on their Colonie account, or, until they set
// one (or while it cannot load), their initial on a colour of their own that
// stays the same everywhere, so people are easy to tell apart in a group.
import { useState } from "react";
import { cn } from "@/lib/cn";

const COLORS = ["#7b61ff", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#d6409f", "#8e4ec6", "#ab6400"];

/** The same colour for the same person (by email, else name). */
export function personColor(seed: string): string {
  let hash = 0;
  for (const char of seed.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

export function personInitial(name: string): string {
  return (name.trim().match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}

export function PersonAvatar({ name, email, src, size = 28, className }: {
  name: string; email?: string; src?: string | null; size?: number; className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const photo = src && failed !== src ? src : null;
  return (
    <span aria-hidden className={cn("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: personColor(email || name) }}>
      {personInitial(name)}
      {photo && <img src={photo} alt="" className="absolute inset-0 size-full object-cover" onError={() => setFailed(photo)} />}
    </span>
  );
}
