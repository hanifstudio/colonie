# Handover

What is being worked on now, and what comes next. Rewrite this page as things
change; delete finished work. History is in Git.

Updated October 21, 2026.

## Now: everything a first public release with Shared workspaces needs

Owner, October 21: keep going until release. Done: privacy by person, Colonie
Cloud with invite by link, the server image (`deploy/`, tried in Docker
against the live cloud), engine sign-in from the admin's browser. In order:

1. **Current: one-click deployment to DigitalOcean.** From the new-workspace
   form, the owner picks Shared, connects DigitalOcean in the browser (OAuth
   with PKCE, the app registers itself, no secret), sees the monthly price
   from DigitalOcean, and creates the workspace: one droplet in Singapore,
   tagged, behind a firewall (80 and 443), set up on first boot to run the
   server image with Caddy on `<ip>.sslip.io`. When it answers, the app opens
   its owner invite, and they sign in as its first admin. Deleting removes
   the droplet and firewall by tag. Proof: tests against a stand-in
   DigitalOcean API (OAuth, account limits, price, create, wait, delete) and
   the generated first-boot script checked against `deploy/`. Out of scope
   here: publishing the image (next), a custom domain, backups.
2. Publishing the server image where a droplet can pull it.
3. Group conversations with people and bots.
4. Bot memory learns from every member (today only unsigned messages).
5. Release: CI on this branch, a `.dmg`, the Colonie Cloud domain.

Done and unchecked in a real window: Settings, People invite links; Join a
Shared workspace (profile menu and workspace menu), passing through Colonie
Cloud. Missing: removing a member.

**Colonie Cloud is live** at https://colonie-cloud.hanifyaskur.workers.dev
(Neon through Hyperdrive `9cadf41e…`, schema `colonie_cloud`). After the
owner resets the Neon password: `wrangler hyperdrive update
9cadf41ef5894f3eafbf22df42ef749c --connection-string=…`. Before outside users:
a domain, per-IP limits, `/forgot` timing (Turnstile deferred).
The server image is about 3 GB.

## Before a public release

| What must be true | Status |
|---|---|
| The release is built from code that reaches `main` | Waiting on the owner (see blueprint) |
| CI passes on that code | Broken: CI still calls scripts deleted from this branch |
| A version number and an update path for people on 0.2.0 | Not decided |
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
