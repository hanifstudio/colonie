import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** The one button. Use it instead of writing button classes again.
 * primary: the one thing to do here. secondary: any other action. quiet: a small link-like choice.
 * The sizes and colors are the ones the app already used most, so moving a button here changes nothing. */
export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "md" | "sm";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "rounded-lg bg-accent font-medium text-accent-ink hover:opacity-90 disabled:opacity-50",
  secondary: "rounded-lg bg-raised text-ink hover:bg-control disabled:opacity-50",
  quiet: "rounded-md text-ink-secondary underline decoration-ink-tertiary underline-offset-2 hover:text-ink disabled:opacity-50",
};
const SIZE: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: { md: "px-4 py-2 text-[13px]", sm: "px-3 py-1.5 text-[12.5px]" },
  secondary: { md: "px-3 py-1.5 text-[12.5px]", sm: "px-2.5 py-1 text-[12px]" },
  quiet: { md: "text-[12.5px]", sm: "text-[12px]" },
};
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={cn(VARIANT[variant], SIZE[variant][size], FOCUS, className)} {...rest} />;
}
