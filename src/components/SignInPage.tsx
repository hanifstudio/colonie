// What a browser shows when it opens a Shared workspace without being signed
// in: a way in with a Colonie account, or, where the workspace offers none, a
// plain note. The desktop app's own window never sees this; it is the owner
// of its own server.

/** Where the Colonie sign-in starts: the server sends the person on to Colonie
 * Cloud and back (server/colonie/accounts/). */
export const COLONIE_SIGN_IN_PATH = "/auth/colonie/signin";

export function SignInPage({ colonieSignIn, workspace }: { colonieSignIn: boolean; workspace: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-4 text-ink">
      <section aria-labelledby="sign-in-title" className="w-full max-w-sm rounded-2xl border border-hairline/50 bg-panel p-6">
        <h1 id="sign-in-title" className="text-[17px] font-semibold">Sign in to {workspace}</h1>
        {colonieSignIn ? (
          <>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
              Use your Colonie account. If you were invited, open the invite link you were sent instead.
            </p>
            <a
              href={COLONIE_SIGN_IN_PATH}
              className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2 text-[13.5px] font-medium text-accent-ink"
            >
              Sign in with Colonie
            </a>
          </>
        ) : (
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
            This workspace has no sign-in yet. Ask its owner for an invite link.
          </p>
        )}
      </section>
    </main>
  );
}
