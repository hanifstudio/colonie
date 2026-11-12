import type { ReactNode } from "react";

/** A panel that has nothing to show yet: an icon, a title, one or two plain sentences, and what to do.
 * Every empty, starting and not-available state in a panel uses this, so they read as one family. */
export function EmptyCard({ label, icon, title, body, note, problem, children }: {
  /** What the region is, for screen readers. */
  label: string; icon: ReactNode; title: string; body?: string; note?: string; problem?: string; children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-10 text-center" role="region" aria-label={label}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-card text-ink-secondary">{icon}</div>
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {body && <p className="mt-1.5 max-w-[34ch] text-[13px] leading-relaxed text-ink-secondary">{body}</p>}
      {note && <p className="mt-2 max-w-[34ch] text-[12px] leading-relaxed text-ink-tertiary">{note}</p>}
      {problem && <p role="alert" className="mt-3 max-w-[38ch] text-[12.5px] leading-relaxed text-danger">{problem}</p>}
      {children && <div className="mt-5 flex flex-col items-center gap-3">{children}</div>}
    </div>
  );
}
