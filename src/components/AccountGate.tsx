// The desktop app's first screen until the person has a Colonie account.
// Everyone signs up (or in) once, Local included (owner decision): one
// identity for this computer and every Shared workspace. It happens in the
// browser, and the app comes back on its own. After that the account is
// never checked again, so a Local workspace keeps working offline; and when
// the app cannot tell (no answer), it lets the person in rather than lock
// them out of their own computer.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";

type Answer = { status: number; body: { required?: boolean; account?: { email: string; name: string } | null } | null } | null;

export function needsAccount(answer: Answer): boolean {
  return answer?.status === 200 && answer.body?.required === true && !answer.body.account;
}

async function ask(): Promise<Answer> {
  try {
    const res = await fetch("/api/colonie-account", { credentials: "same-origin" });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

export function AccountGateView({ waiting, busy, error, onStart }: { waiting: boolean; busy: boolean; error: string; onStart: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-ink" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <div className="w-full max-w-[420px] rounded-[20px] border border-hairline/50 bg-panel p-7 text-center shadow-2xl shadow-black/40" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <h1 className="text-[20px] font-semibold">Welcome to Colonie</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
          Create your Colonie account, or sign in. It is one account for this computer and every Shared workspace
          you create or join. You only do this once.
        </p>
        <button type="button" onClick={onStart} disabled={busy}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
          {busy && <HIcon icon={Loading02Icon} size={15} className="animate-spin" />}Sign up or sign in
        </button>
        {waiting && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
            Finish in the Colonie account window. This window continues by itself when you are done.
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
      </div>
    </main>
  );
}

export function AccountGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "needed" | "done">("checking");
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = useCallback(async () => setState(needsAccount(await ask()) ? "needed" : "done"), []);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (state !== "needed" || !waiting) return;
    const timer = setInterval(() => void check(), 2_000);
    return () => clearInterval(timer);
  }, [state, waiting, check]);
  if (state === "checking") return null;
  if (state === "done") return <>{children}</>;
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/colonie-account/start", { method: "POST", credentials: "same-origin" });
      const body = await res.json().catch(() => null) as { authorizationUrl?: string; error?: string } | null;
      if (!res.ok || !body?.authorizationUrl) throw new Error(body?.error ?? "Colonie accounts cannot be reached right now. Try again.");
      // In a window of this app, so the sign-in it keeps also opens Shared
      // workspaces later; elsewhere the system browser.
      if (window.colonie?.account) await window.colonie.account.openWindow(body.authorizationUrl);
      else window.open(body.authorizationUrl, "_blank", "noopener");
      setWaiting(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <AccountGateView waiting={waiting} busy={busy} error={error} onStart={() => void start()} />;
}
