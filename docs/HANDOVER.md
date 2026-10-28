# Handover

## Now: verify routines, guides, and group replies with real engines

Use signed-in Claude and Codex in disposable workspaces, with bounded tasks.
Prove scheduling and changing a routine, its report in the originating group,
saving a guide from chat, and a group reply with the right person's approval.
Out of scope: event triggers and the owner's real data.

## Next: prepare the first public release

1. **The team code leaves the server.** Teams are gone from the app
   (owner, October 23). Left on the server: sections and their shared
   instructions, team memory, the section boundary between bots, a Chief
   per section, team routes, library, import and package code, and their
   tests. One Chief for the workspace, no boundary; prepared by the agent,
   committed by the owner (the hook keeps test deletions for the owner).
2. A lifetime license for Shared, bought once (owner decision); later.
3. Release: a signed, notarized `.dmg` (friends get an unsigned build from
   GitHub Releases, tag `friends-<version>`, so the legacy updater mirror
   skips it), the Colonie Cloud domain; the server image's last 600 MB
   (web-app-only packages, Next.js via better-auth).

Not yet seen in a real window: the installed app opening a `colonie://` link.

**Colonie Cloud is live** at https://colonie-cloud.hanifyaskur.workers.dev
(Neon through Hyperdrive `9cadf41e…`, schema `colonie_cloud`). After the
owner resets the Neon password: `wrangler hyperdrive update
9cadf41ef5894f3eafbf22df42ef749c --connection-string=…`. Before outside users:
a domain, per-IP limits, `/forgot` timing (Turnstile deferred).

## Before a public release

| What must be true | Status |
|---|---|
| CI passes on `main` | Green on GitHub: `pnpm check` and the Shared workspace journey |
| A version number and an update path | Server 0.3.8 is published. A raised package.json version on main publishes the image and Shared admins see Update |
| A Mac app built from this branch | Built unpacked; no `.dmg`; never installed on a clean Mac |
| First run works in a real window | Never seen in a window |
| Sign-in inside the app works with a real account | Never tried on a clean install |
| A bot answers through a real engine | Works in the owner's own data; never on a clean install |
| Creating and switching workspaces works by clicking | Tested in code only; never clicked |
| Conversations from the 0.2.0 build still work after upgrading | Not tested |
| The download is signed and notarized | Blocked: no Apple Developer account |
| The download page points to the new build | Not started |
| A bad release can be pulled back | Guard exists; recovery never rehearsed |
| A Shared workspace: one-click server, invite by link, people and bots together | Done and used on the owner's server; the Update button not yet used there |

## Known broken

- The desktop Release workflow needs `RELEASES_PAT` for the legacy updater bridge.

- `pnpm test:electron`: two tests (`mac-updater`, `vendor-updater`) import
  scripts that were deleted.
- `pnpm i18n:check`, `pnpm clean`, and `pnpm check:contrast` call deleted scripts.
- `electron/fixtures/browser-closed-shadow.cjs` requires a file that does not exist.
- 72 failing test files were deleted on October 18 by owner decision, so those
  areas have no tests now.

## Not yet checked by a person

- No reset email has gone through Resend; the reset pages were never opened in a browser.
- OpenCode's project rules load but were never seen blocking in a live
  session; Codex runs the project hook only after each person trusts it.
- The workspace switcher and the new welcome step have never been seen in a
  real window. The app's restart into another workspace has never been run.
- The owner's two stuck conversations, "Motion" and "Biscuit", should now
  rebuild their session. The next message sent in either one is the real check.
- A group's Files panel was never seen in a window, and no real engine has yet
  written into a group's project folder. A file a bot links in a group answer
  still opens only through the old per-bot rule, not the project folder.

## Queue after the current task

1. A person installs Colonie on a clean Mac from a `.dmg` and completes the
   first run in a real window, with throwaway data.
2. Each bot browses with its own browser and logins, on ACP. A person logs
   in for it once, watches it, and can take over. Local and Shared servers
   (which have no browser yet). Screen control of desktop apps comes later.
3. Gaps in the engine connection, each needing a decision before code:
   - A message cannot be sent into a turn that is already running (no steering
     on the ACP engines).
   - Editing an earlier message (branching) does not work on ACP. Plan: open a
     fresh engine session for the branch and give it that branch's history.
   - Full tool results are never kept on ACP, so work summaries show previews only.
   - Old readers of `native/<thread>.ndjson` files remain, though nothing
     writes those files anymore. Decide which to keep.
4. Small fix: email sign-in answers 502 saying the accounts-service address
   "is set" when it is not set at all.
5. Remove the leftover brand word `maus`: first the unused `runOn` setting on
   routines and webhooks, then the mascot's CSS and component names.
6. Tidy the interface code into feature folders, one feature at a time.
