// Small presentational primitives for the Colonie platform shell. They reuse
// the app's existing tokens and Icons so the Cloud workspace reads like the
// rest of Colonie instead of a bolted-on form. Copy is English (US).
import {
  useEffect, useId, useRef,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react";
import { Alert02Icon, InformationCircleIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HIcon, type HIconElement } from "@/components/HIcon";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { botColor, initialsOf, type PrincipalKindUnion, type PlatformBot } from "@/lib/colonie-platform";
import { classicBot } from "@/lib/colonie-classic-ui";
import { stateForBot } from "@/lib/mascot";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet";

export function Button({
  variant = "secondary",
  icon,
  className,
  children,
  busy = false,
  ...rest
}: {
  variant?: ButtonVariant;
  icon?: HIconElement;
  busy?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-accent text-accent-ink hover:bg-accent/90 disabled:bg-accent/40",
    secondary: "bg-raised text-ink hover:bg-raised-hover",
    ghost: "text-ink-secondary hover:bg-raised hover:text-ink",
    quiet: "text-ink-secondary hover:text-ink underline decoration-hairline underline-offset-2",
    danger: "bg-danger/90 text-danger-ink hover:bg-danger",
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        styles[variant],
        FOCUS,
        className,
      )}
    >
      {busy ? <Spinner size={13} /> : icon ? <HIcon icon={icon} size={14} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  className,
  ...rest
}: { label: string; icon: HIconElement } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn("inline-flex size-7 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink", FOCUS, className)}
    >
      <HIcon icon={icon} size={15} aria-hidden="true" />
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]", className)}
      style={{ width: size, height: size }}
    />
  );
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: string; error?: string | null; children: ReactNode; id?: string }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1 block text-[12px] font-medium text-ink-secondary">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-[12px] text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] text-ink-tertiary">{hint}</span>
      ) : null}
    </label>
  );
}

const inputClass = cn(
  "block w-full rounded-lg border border-hairline/70 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-tertiary",
  FOCUS,
);

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(inputClass, className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(inputClass, "resize-none", className)} />;
}

const NATIVE_SELECT = cn(inputClass, "appearance-none bg-inset pr-8");

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(NATIVE_SELECT, className)}>
      {children}
    </select>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed",
        tone === "error" ? "bg-danger/12 text-danger" : "bg-raised text-ink-secondary",
      )}
    >
      <HIcon icon={tone === "error" ? Alert02Icon : InformationCircleIcon} size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" }) {
  const tones = {
    neutral: "bg-raised text-ink-secondary",
    accent: "bg-accent/15 text-accent",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
  } as const;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", tones[tone])}>{children}</span>;
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">{children}</span>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: HIconElement; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {icon ? (
        <span className="flex size-12 items-center justify-center rounded-2xl bg-raised text-ink-secondary">
          <HIcon icon={icon} size={22} aria-hidden="true" />
        </span>
      ) : null}
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      {description ? <p className="max-w-sm text-[13px] leading-relaxed text-ink-secondary">{description}</p> : null}
      {action}
    </div>
  );
}

/** A modal surface. Esc closes; the panel takes focus on open; the backdrop
 * closes. Kept deliberately small — one dialog pattern for the whole shell. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const labelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-hairline bg-panel text-ink shadow-2xl outline-none sm:rounded-2xl",
          wide ? "sm:max-w-xl" : "sm:max-w-md",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <h2 id={labelId} className="text-[15px] font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{description}</p> : null}
          </div>
          <IconButton label="Close" icon={Cancel01Icon} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function HumanAvatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-accent/20 font-semibold text-accent"
    >
      {initialsOf(name)}
    </span>
  );
}

export function BotAvatarView({ id, name, size = 28, profile }: { id: string; name: string; size?: number; profile?: PlatformBot }) {
  const bot = profile ? classicBot(profile) : null;
  return <BotAvatar bot={bot ?? { color: botColor(id), name }} state={bot ? stateForBot(bot) : undefined} label={name} size={size} animated={false} />;
}

export function AvatarFor({ kind, id, name, size = 28, profile }: { kind: PrincipalKindUnion; id: string; name: string; size?: number; profile?: PlatformBot }) {
  return kind === "bot" ? <BotAvatarView id={id} name={name} size={size} profile={profile} /> : <HumanAvatar name={name} size={size} />;
}
