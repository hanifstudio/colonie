// Whether the app may change which workspace it runs, and what that costs.
//
// Kept out of Electron so the answer can be tested: the decision is three
// refusals and one question about the directory. Each refusal has its own
// reason, because "it did not work" teaches nobody anything, and the refusal
// happens *before* the choice is recorded — recording a workspace the app then
// cannot start in is how an installation stops opening.

/** The reported reason a switch was refused. The caller shows its own words. */
export const SWITCH_REFUSED = Object.freeze({
  NOT_NAMED: "not-named",
  NOT_LISTED: "not-listed",
  IN_USE: "in-use",
});

/**
 * What changing the running workspace takes.
 *
 * `directoryAvailable` is asked only about a workspace that is not the running
 * one, and it must answer "could a server start here right now" — in the app
 * that is the data-directory lease, taken and given back, so the answer is the
 * one the next start gets.
 *
 * `packaged` says who owns the server. The app owns it when packaged, so it can
 * come back in the chosen workspace on its own; in a source checkout the
 * launcher owns it, so the person reopens Colonie instead.
 */
export function planWorkspaceSwitch({ id, workspaces, activeId, directoryAvailable, packaged }) {
  const wanted = typeof id === "string" && id.trim() ? id.trim() : null;
  if (!wanted) return { ok: false, code: SWITCH_REFUSED.NOT_NAMED };
  const listed = Array.isArray(workspaces) ? workspaces : [];
  // A record with no directory is not a workspace this app can run, so it is
  // refused the same way a stale id is: the list itself is validated when it is
  // read, and this keeps the decision honest about what it was handed.
  const target = listed.find(
    (workspace) => workspace?.id === wanted && typeof workspace.dir === "string" && workspace.dir.trim() !== "",
  ) ?? null;
  if (!target) return { ok: false, code: SWITCH_REFUSED.NOT_LISTED };
  if (target.id === activeId) return { ok: true, mode: "already-open", target };
  if (!directoryAvailable(target.dir)) return { ok: false, code: SWITCH_REFUSED.IN_USE, target };
  return { ok: true, mode: packaged ? "restart-app" : "reopen-colonie", target };
}
