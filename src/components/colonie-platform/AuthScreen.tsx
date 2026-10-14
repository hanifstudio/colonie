// Account comes first: sign up (no email verification) or sign in. When an
// invitation is pending, the heading says so and the account is created before
// the invitation is accepted, so the invitation continues through auth.
import { useState, type FormEvent } from "react";
import { CloudIcon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { Button, Field, Notice, Spinner, TextInput } from "./ui";
import type { PlatformAccount, PlatformClient } from "@/lib/colonie-platform";

export function AuthScreen({
  client,
  invitePending,
  onAuthenticated,
}: {
  client: PlatformClient;
  invitePending: boolean;
  onAuthenticated: (account: PlatformAccount, created: boolean) => void;
}) {
  const [mode, setMode] = useState<"signup" | "signin" | "recover">(invitePending ? "signin" : "signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const signup = mode === "signup";
  const recover = mode === "recover";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (recover) {
      if (!recoveryKey.trim()) return setError("Enter your recovery key.");
      if (password.length < 8) return setError("Use at least 8 characters for your new password.");
      setBusy(true);
      setError(null);
      try {
        await client.recoverAccount({ recoveryKey: recoveryKey.trim(), newPassword: password });
        setRecoveryKey("");
        setPassword("");
        setNotice("Password updated. Sign in with your new password.");
        setMode("signin");
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!email.trim()) return setError("Enter your email address.");
    if (signup && !name.trim()) return setError("Enter your name.");
    if (password.length < 8) return setError("Use at least 8 characters for your password.");
    setBusy(true);
    setError(null);
    try {
      const result = signup
        ? await client.signUp({ email: email.trim(), password, name: name.trim() })
        : await client.signIn({ email: email.trim(), password });
      onAuthenticated(result.user, signup);
    } catch (cause) {
      setError(messageFor(cause));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-app p-4 text-ink">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
            <HIcon icon={CloudIcon} size={24} aria-hidden="true" />
          </span>
          <h1 className="text-[20px] font-semibold">Welcome to Colonie</h1>
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            {invitePending
              ? "Sign in or create an account to join the workspace you were invited to."
              : "Create your account to start a workspace with people and AI bots."}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3 rounded-2xl border border-hairline bg-panel p-5">
          {recover ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                Enter a recovery key you generated earlier in Account recovery, then choose a new password.
              </p>
              <Field label="Recovery key" id="colonie-recovery-key">
                <TextInput id="colonie-recovery-key" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} autoComplete="off" placeholder="XXXX-XXXX-XXXX" />
              </Field>
              <Field label="New password" hint="At least 8 characters." id="colonie-new-password">
                <TextInput id="colonie-new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
            </>
          ) : (
            <>
              {signup && (
                <Field label="Your name" id="colonie-name">
                  <TextInput id="colonie-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada Lovelace" />
                </Field>
              )}
              <Field label="Email" id="colonie-email">
                <TextInput id="colonie-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
              </Field>
              <Field label="Password" hint={signup ? "At least 8 characters." : undefined} id="colonie-password">
                <TextInput id="colonie-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? "new-password" : "current-password"} placeholder="••••••••" />
              </Field>
            </>
          )}

          {error && <Notice tone="error">{error}</Notice>}
          {notice && <Notice>{notice}</Notice>}

          <Button type="submit" variant="primary" busy={busy} className="w-full py-2">
            {recover ? "Reset password" : signup ? "Create account" : "Sign in"}
          </Button>

          <div className="space-y-1 text-center text-[12.5px] text-ink-secondary">
            {recover ? (
              <p>
                <button type="button" onClick={() => { setMode("signin"); setError(null); setNotice(null); }} className="font-medium text-accent underline-offset-2 hover:underline">
                  Back to sign in
                </button>
              </p>
            ) : (
              <>
                <p>
                  {signup ? "Already have an account?" : "New to Colonie?"}{" "}
                  <button type="button" onClick={() => { setMode(signup ? "signin" : "signup"); setError(null); setNotice(null); }} className="font-medium text-accent underline-offset-2 hover:underline">
                    {signup ? "Sign in" : "Create one"}
                  </button>
                </p>
                {!signup && (
                  <p>
                    <button type="button" onClick={() => { setMode("recover"); setError(null); setNotice(null); }} className="text-ink-tertiary underline-offset-2 hover:text-ink hover:underline">
                      Forgot your password?
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </form>

        {invitePending && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[12px] text-ink-tertiary">
            <HIcon icon={UserAdd01Icon} size={13} aria-hidden="true" />
            Your invitation is kept until you finish signing in.
          </p>
        )}
      </div>
    </div>
  );
}

function messageFor(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/already exists|already registered|user already/i.test(text)) return "That email already has an account. Sign in instead.";
  if (/invalid|incorrect|credentials/i.test(text)) return "That email and password did not match.";
  if (/password/i.test(text) && /short|length|characters/i.test(text)) return "Use at least 8 characters for your password.";
  return text || "Something went wrong. Please try again.";
}

/** Kept exported for the boot spinner so both screens share one look. */
export function BootScreen({ label = "Loading your workspaces…" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center gap-2 bg-app text-[13px] text-ink-secondary">
      <Spinner /> {label}
    </div>
  );
}
