# Launch board

How far Colonie is from being published for people outside this Mac, gate by
gate. This page is a view, not a second plan: **a row moves only with the
evidence named in it.** Task records live in [HANDOVER](HANDOVER.md), dated
evidence in [PROGRESS](PROGRESS.md), the product plan in the
[blueprint](COLONIE-BLUEPRINT.md) (roadmap stage P7). Statuses: **done**
(evidence exists), **partial** (what is missing is written down), **blocked**
(the reason is written down), **not started**.

## Next milestone

**L1 — one person installs the current tree and completes the first-run journey.**
Install → first-run welcome → sign in to one engine → a bot answers a message →
create and switch a workspace → quit and reopen. Together with S2 (CI can gate
the release commit), that is the smallest honest step toward a public build.

## 1. The ship path — can we release the code we actually test?

| # | What must be true | How it is proven | Status |
|---|---|---|---|
| S1 | The code we ship is the code we test. `main` is where CI and Release run; today `restructure` is 152 commits ahead of it and unpushed. | A recorded decision on how the current tree reaches `main`, then the merge itself. | not started |
| S2 | CI passes on the release commit. Release refuses a commit without a passing CI verdict. CI still calls files that exist on `main` but not in the current tree: `scripts/generate-locale.mjs`, `scripts/check-electron.mjs`, `scripts/smoke-packaged-server.mjs`, `scripts/prepare-cua-win.mjs`, `scripts/smoke-cua-win-embedded.mjs`, `scripts/prepare-cua-linux.mjs`, `scripts/smoke-cua-x11-input.mjs`, `scripts/run-linux-package-smoke.mjs`, and three `scripts/testing/*.test.ts` selected by name. | A CI run on the release commit, green. | blocked |
| S3 | Version and update story are decided: `package.json` is `0.2.0`, and the installed `/Applications/Colonie.app` is `0.2.0` from October 15 (the earlier build). | A recorded version for the first public release and what people on `0.2.0` get. | not started |
| S4 | A macOS artifact is built from the current tree. The tooling exists (`electron-builder.colonie.yml`, `release.yml`, `pnpm colonie:dist`) and has never produced an artifact here (`release/` and `dist-colonie/` do not exist). | `pnpm colonie:dist`, then the artifact installed and launched on a Mac that never had Colonie. | not started |

## 2. The floor a person meets — does the first week work?

| # | What must be true | How it is proven | Status |
|---|---|---|---|
| F1 | First run works: welcome flow unchanged, the first Local workspace created for the person, Server shown and disabled. | E02.5's recorded engine/render checks, plus a first run in a real window. | partial — never seen in a window |
| F2 | The person signs in to an engine inside the app, and that sign-in is the app's own (a logged-in terminal CLI does not count). | A real sign-in through the app's engine setup on a clean install. | partial — implemented, unproven with a real provider |
| F3 | A bot answers a real message through a real provider. | A bounded real-provider turn on a disposable workspace. | partial — has happened in the owner's own data, never on a clean install; provider allowance is needed |
| F4 | Workspace create and switch are clickable end to end. | E02.4's checks, plus a click-through in a window. | partial — engine/unit verified, never clicked |
| F5 | Data keeps working when the app changes under it: a conversation whose engine session is gone is rebuilt instead of dying (`6cd23a99`), and conversations saved by the earlier build are considered. | The resume-rebuild fixture test, plus one real conversation that was saved before the change. | partial — the rebuild is tested; the upgrade from `0.2.0` is not |

## 3. Publishing — can people get it, and can we take it back?

| # | What must be true | How it is proven | Status |
|---|---|---|---|
| U1 | Signing and notarization secrets are present and a rehearsal release runs end to end. | One `release.yml` run pinned to a throwaway version. | not started |
| U2 | The download people reach has the new artifact, with the README/landing text matching it. | The published draft opened and its downloads checked. | not started |
| U3 | A bad release can be stopped: Release refuses to overwrite a published version (`0.1.24` was an invisible draft). | The documented recovery for a bad publish, rehearsed once. | partial — the guard exists, recovery is untested |

## Open owner decision

Platform scope for the first public release. Today the macOS config is Apple
silicon only, and the Intel/Windows/Linux jobs depend on tooling that CI can no
longer run (S2). macOS-only first is the smaller promise; saying so is part of
the launch.
