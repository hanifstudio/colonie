/** A small green pulsing dot: something is happening here now. Always give it a label for screen readers. */
export function StatusDot({ label, testId }: { label: string; testId?: string }) {
  return <span role="img" aria-label={label} data-testid={testId} className="size-1.5 animate-pulse rounded-full bg-success" />;
}
