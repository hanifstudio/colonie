// Account recovery, kept out of the way. A person creates one recovery key
// while signed in and keeps it; if they lose their password, the key plus a new
// password gets them back in without any email. The key is shown exactly once.
import { useState } from "react";
import { Copy01Icon, Key01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { Button, Modal, Notice } from "./ui";
import type { PlatformClient } from "@/lib/colonie-platform";

export function RecoveryKeyDialog({
  open,
  onClose,
  client,
}: {
  open: boolean;
  onClose: () => void;
  client: PlatformClient;
}) {
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const secret = await client.createRecoveryKey();
      setKey(secret.recoveryKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The recovery key could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Account recovery"
      description="Save a recovery key so you can get back in without email."
      footer={<Button variant="ghost" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-xl border border-hairline bg-inset/50 p-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
            <HIcon icon={Key01Icon} size={14} aria-hidden="true" />
          </span>
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            Colonie does not send email. A recovery key is the way back in if you forget your password.
            Treat it like a password: anyone who has it can reset your account.
          </p>
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        {key ? (
          <div className="space-y-2">
            <Notice>
              This key is shown once. Copy it somewhere safe now. Creating a new key replaces this one.
            </Notice>
            <KeyField value={key} />
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button variant={key ? "secondary" : "primary"} icon={Key01Icon} busy={busy} onClick={() => void create()}>
            {key ? "Replace recovery key" : "Create recovery key"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The one and only time a new account sees its recovery key. Shown straight
 * after signup, when the person can still save it; never stored anywhere. */
export function RecoveryKeyStep({ recoveryKey, onContinue }: { recoveryKey: string; onContinue: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col bg-app text-ink">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-4 pb-12 sm:px-6">
        <div>
          <h1 className="text-[22px] font-semibold">Save your recovery key</h1>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">
            Colonie does not send email, so this key is the only way back into your account if you forget your password.
            This is the only time it is shown. Keep it somewhere safe; anyone who has it can reset your account.
          </p>
        </div>
        <div>
          <KeyField value={recoveryKey} />
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onContinue}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

export function KeyField({ value }: { value: string }) {  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-lg bg-panel px-2 py-1.5">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-[12.5px] text-ink">{value}</code>
      <Button variant="secondary" icon={copied ? Tick01Icon : Copy01Icon} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
