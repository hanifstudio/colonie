# Welcome flow (guided tour disabled)

Launch the isolated full-app fixture following [Chat UI](chat-ui.md):

```sh
node --experimental-strip-types scripts/control-colonie.ts ui launch
```

In a second terminal, pass its exact printed handle:

```sh
node --experimental-strip-types scripts/verify-onboarding-ui.ts /tmp/colonie-verify-data-XXXXXX/ui.json
```

The recipe resets the workspace onboarding record first, so it can rerun on one
fixture; it also clears only its browser storage, then enables first-run
onboarding through the fixture-only `?onboarding=1` entry. It uses the real
renderer and fake-engine server. No provider login, native permissions or user
workspace is involved.

Assertions cover profile-save failure and retry, reduced-motion reel playback,
the engines beat's provider framing with a refresh failure that keeps its
inventory, no phone beat, welcome completion, no guided tour after finishing,
persistence after reload, the greeting's disabled "Skip tour", and the Settings
replay with a skip while its save is pending. Screenshots are retained in
`.colonie-scratch/verify-evidence/onboarding/` with a PASS line for each workflow.
Actual provider authentication and native Electron permissions remain covered
by their separate platform recipes, not this browser fixture.

Stop the launcher with Ctrl-C; it owns and removes only its disposable home.

## Colonie adaptations (Oct 11 2026)

The Colonie onboarding is reused, with these Colonie changes:

| Surface | Change |
|---|---|
| Guided tour + first-conversation spotlights | Disabled for now: `GuidedTour` and `FirstConversationTour` are no longer mounted, the welcome flow hands straight to the chat, and Settings has no "Replay app tour" button (`src/App.tsx`, `src/components/onboarding/WelcomeGate.tsx`, `src/components/SettingsModal.tsx`). |
| Engines beat | Organisaton sign-in row removed (there is no organisation in Colonie); the beat frames Codex / Claude Code as the choice and adds helper copy when neither is installed (`src/components/onboarding/beats/EnginesBeat.tsx`). |
| Hello beat | Name and email are now required; the "Maybe later" skip is gone and the top-right "Skip tour" is disabled on this beat, so it is truly mandatory (`src/components/onboarding/beats/HelloBeat.tsx`, `src/components/onboarding/WelcomeFlow.tsx`). |
| Phone beat | Removed from the flow entirely (`src/components/onboarding/beats/PhoneBeat.tsx` deleted; `beatsFor` in `src/lib/onboarding.ts`). |
| Meet your bot | Adds a Bloub body picker beside the color picker; the bot preview and the flow guide follow the pointer anywhere in the window (`followGlobalPointer`) (`src/components/onboarding/beats/MeetYourBotBeat.tsx`, `src/components/onboarding/WelcomeFlow.tsx`). |
| Reel | Per the owner's call it stays as designed, with the visible `Colonie` / `Maus` strings changed to `Colonie` (`src/components/onboarding/reel/scenes/`). |
| Permissions | Unchanged. |

Covered by `src/components/onboarding/WelcomeGate.test.ts`,
`src/components/onboarding/beats/EnginesBeat.test.ts`, `src/lib/onboarding.test.ts`,
the `pnpm i18n:check` gate for the new English keys, and the isolated recipe
above.

## Organization row, hosted beats and member note (Sep 23 2026)

What each first-run surface depends on, and how it was checked. The
organization row is no longer offered by the engines beat; the hosted/member
behaviour below still stands.

| Who opens the app | What they get | Checked by |
|---|---|---|
| Desktop app, own server (full bridge, `remoteClient` present) | The same flow as before, decided without a new request | `src/components/onboarding/WelcomeGate.test.ts`; `HelloBeat` HTML compared with main (no bridge) |
| Hosted workspace opened inside the desktop app (reduced bridge, no `remoteClient`) | Treated like a browser: the server is asked | `src/components/onboarding/WelcomeGate.test.ts` |
| Browser, admin of a hosted workspace | Greeting (no inputs) and the bot beat only | `src/components/onboarding/WelcomeGate.test.ts`, `src/components/onboarding/beats/HelloBeat.test.ts`, `src/lib/onboarding.test.ts` |
| Browser, hosted member (no admin scope) | No welcome flow; one dismissible note kept in browser storage | `src/components/onboarding/WelcomeGate.test.ts` |
| Browser, client-scope session on a server that is not hosted | Nothing new: the flow does not open itself (it could not be saved); Settings replay as before | `src/components/onboarding/WelcomeGate.test.ts`, `src/lib/onboarding.test.ts` |

`GET /api/auth/session` adds `hosted: true` for a session on a hosted
workspace and is otherwise unchanged (`server/hosted-access.test.ts`,
`server/email-signin.test.ts`).

Not covered here: the real Electron preload bridge and a real hosted
tenant's browser.