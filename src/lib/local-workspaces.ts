// What the sidebar says about the workspaces on this computer: whether a name
// can be sent yet, what a change does next, and why one was refused. Kept out
// of the component so every answer can be checked without a bridge, a window or
// a running app.
import { brand } from "./brand";
import { t } from "./i18n";

/** What a typed name still needs, if anything. The bound is the app's own
 * (`LocalWorkspaceState.nameMax`), so the field refuses what the workspace
 * module would refuse rather than a second, drifting rule. */
export function workspaceNameIssue(name: string, max: number): "" | "required" | "too-long" {
  const wanted = name.trim();
  if (!wanted) return "required";
  return wanted.length > max ? "too-long" : "";
}

export function nameIssueMessage(issue: "required" | "too-long", max: number): string {
  return issue === "required"
    ? t("sidebar.workspace.nameRequired")
    : t("sidebar.workspace.nameTooLong", { max });
}

/** After the app accepted a change: what the person should expect. The two
 * restarting modes are the whole answer — a workspace that is already open
 * changes nothing, so it has nothing to say. */
export function switchNotice(mode: "already-open" | "restart-app" | "reopen-colonie", name: string): string {
  if (mode === "restart-app") return t("sidebar.workspace.noticeRestart", { app: brand().name, name });
  if (mode === "reopen-colonie") return t("sidebar.workspace.noticeReopen", { name });
  return "";
}

/** Why a change was refused, in the person's words. A code this build does not
 * know falls back to the reason the app sent, so a newer app is still
 * explainable instead of silent. */
export function switchRefusal(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "not-named":
      return t("sidebar.workspace.refusedNotNamed");
    case "not-listed":
      return t("sidebar.workspace.refusedNotListed");
    case "in-use":
      return t("sidebar.workspace.refusedInUse");
    case "unwritable":
      return t("sidebar.workspace.refusedUnwritable");
    default:
      return fallback?.trim() || t("sidebar.workspace.refused");
  }
}
