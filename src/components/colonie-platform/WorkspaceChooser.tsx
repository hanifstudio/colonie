// No workspaces yet: choose Cloud or Local. Every creation asks, always.
// Cloud uses platform AI (no engine setup); Local signs in the engines on this
// Mac. The choice is a property of the workspace, so a person can make both.
import { useState } from "react";
import { CloudIcon, ComputerIcon, Key01Icon, Logout01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { Button, Field, Notice, TextInput } from "./ui";
import type { PlatformAccount } from "@/lib/colonie-platform";

export function WorkspaceChooser({
  account,
  canCreateLocal,
  localUnavailableReason,
  busy,
  error,
  onCreateCloud,
  onCreateLocal,
  onSignOut,
  onOpenAccount,
}: {
  account: PlatformAccount;
  canCreateLocal: boolean;
  localUnavailableReason?: string;
  busy: "cloud" | "local" | null;
  error: string | null;
  onCreateCloud: (name: string) => void;
  onCreateLocal: (name: string) => void;
  onSignOut: () => void;
  onOpenAccount?: () => void;
}) {
  const [name, setName] = useState(`${firstName(account.name)}'s workspace`);

  return (
    <div className="flex min-h-dvh flex-col bg-app text-ink">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <span className="text-[13px] font-medium text-ink-secondary">Signed in as {account.email}</span>
        <Button variant="ghost" icon={Logout01Icon} onClick={onSignOut}>Sign out</Button>
        {onOpenAccount ? (
          <Button variant="ghost" icon={Key01Icon} onClick={onOpenAccount}>Account recovery</Button>
        ) : null}
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 pb-12 sm:px-6">
        <div className="text-center">
          <h1 className="text-[22px] font-semibold">Create your first workspace</h1>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">
            A workspace is where you and your bots work together. Choose how it runs, and you can always add the other kind later.
          </p>
        </div>

        <div className="mx-auto w-full max-w-sm">
          <Field label="Workspace name" hint="You can rename it later in workspace settings.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme team" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ModeCard
            icon={CloudIcon}
            title="Cloud"
            description="Works with your team from anywhere. Colonie runs the AI, so there is no engine to set up."
            disabled={busy !== null || !name.trim()}
            busy={busy === "cloud"}
            onClick={() => onCreateCloud(name.trim())}
          />
          <ModeCard
            icon={ComputerIcon}
            title="Local"
            description="Private to this Mac. Uses the Claude or Codex you already signed in to."
            disabled={busy !== null || !name.trim() || !canCreateLocal}
            busy={busy === "local"}
            hint={!canCreateLocal ? localUnavailableReason ?? "Local workspaces need the Colonie desktop app." : undefined}
            onClick={() => onCreateLocal(name.trim())}
          />
        </div>

        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </div>
  );
}

function ModeCard({
  icon,
  title,
  description,
  onClick,
  busy,
  disabled,
  hint,
}: {
  icon: Parameters<typeof HIcon>[0]["icon"];
  title: string;
  description: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-2 rounded-2xl border border-hairline bg-panel p-5 text-left transition-colors hover:border-accent/50 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-hairline disabled:hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
        <HIcon icon={icon} size={20} aria-hidden="true" />
      </span>
      <span className="flex items-center gap-2 text-[15px] font-semibold">
        {title}
        {busy ? <span className="text-[12px] font-normal text-ink-secondary">Creating…</span> : null}
      </span>
      <span className="text-[12.5px] leading-relaxed text-ink-secondary">{description}</span>
      {hint ? <span className="text-[12px] leading-relaxed text-warning">{hint}</span> : null}
    </button>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "Your";
}
