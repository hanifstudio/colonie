# Handover

What is being worked on now, and what comes next. Rewrite this page as things
change; delete finished work. History is in Git.

Updated October 21, 2026.

## Now: everything a first public release with Shared workspaces needs

Owner, October 21: keep going until release. Done: privacy by person, Colonie
Cloud with invite by link, the server image (`deploy/`, tried in Docker
against the live cloud), engine sign-in from the admin's browser. In order:

1. **Current: one chat for bots and people, with faces** (owner, October
   22). Groups and DMs work (a person makes a group with people and bots, a
   bot answers when @mentioned, the sidebar lists everyone, a click opens
   the DM). Now: a group or DM looks and works like a chat with a bot (same
   header pill, bubbles, composer); others' messages carry their avatar and
   name. Every person has an avatar: their photo, or a coloured initial.
   The photo belongs to the Colonie account (owner decision), set once at
   Colonie Cloud ("Change photo" in the profile menu), shown in every
   workspace. Proof: view tests, the journey (photo upload against a local
   Colonie Cloud, the photo shown to the other person), screenshots. Out of
   scope: presence, notifications, cropping. Left in the image: web-app-only
   packages and Next.js (via better-auth), about 600 MB.
2. A lifetime license for Shared, bought once (owner decision); later.
3. Release: a signed, notarized `.dmg` (friends get an unsigned build from
   GitHub Releases, tag `friends-<version>`, so the legacy updater mirror
   skips it), the Colonie Cloud domain.

Not yet seen in a real window: the installed app opening a `colonie://`
invite link; Update on a real Shared server.

**Colonie Cloud is live** at https://colonie-cloud.hanifyaskur.workers.dev
(Neon through Hyperdrive `9cadf41e…`, schema `colonie_cloud`). After the
owner resets the Neon password: `wrangler hyperdrive update
9cadf41ef5894f3eafbf22df42ef749c --connection-string=…`. Before outside users:
a domain, per-IP limits, `/forgot` timing (Turnstile deferred).

## Before a public release

| What must be true | Status |
|---|---|
| The release is built from code that reaches `main` | Waiting on the owner (see blueprint) |
| CI passes on that code | Rewritten to run `pnpm check`; never run on GitHub |
| A version number and an update path | 0.3.3. A release raises package.json's version on main; Server image publishes it by itself and Shared admins see Update |
| A Mac app built from this branch | Built unpacked; no `.dmg`; never installed on a clean Mac |
| First run works in a real window | Never seen in a window |
| Sign-in inside the app works with a real account | Never tried on a clean install |
| A bot answers through a real engine | Works in the owner's own data; never on a clean install |
| Creating and switching workspaces works by clicking | Tested in code only; never clicked |
| Conversations from the 0.2.0 build still work after upgrading | Not tested |
| The download is signed and notarized | Blocked: no Apple Developer account |
| The download page points to the new build | Not started |
| A bad release can be pulled back | Guard exists; recovery never rehearsed |
| A Shared workspace: one-click server, invite by link, people and bots together | Privacy and invites done; server, app, groups, deploy to do |

## Known broken

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

## Queue after the current task

1. A person installs Colonie on a clean Mac from a `.dmg` and completes the
   first run in a real window, with throwaway data.
2. Gaps in the engine connection, each needing a decision before code:
   - A message cannot be sent into a turn that is already running (no steering
     on the ACP engines).
   - Editing an earlier message (branching) does not work on ACP. Plan: open a
     fresh engine session for the branch and give it that branch's history.
   - Bots do not get the "this computer" tool on ACP; the code that built it
     only runs on the removed drivers.
   - Full tool results are never kept on ACP, so work summaries show previews only.
   - Old readers of `native/<thread>.ndjson` files remain, though nothing
     writes those files anymore. Decide which to keep.
3. Small fix: email sign-in answers 502 saying the accounts-service address
   "is set" when it is not set at all.
4. Remove the leftover brand word `maus`: first the unused `runOn` setting on
   routines and webhooks, then the mascot's CSS and component names.
5. Tidy the interface code into feature folders, one feature at a time.
