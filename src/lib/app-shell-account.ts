/** The port that lets the one original App Shell also serve an account (Cloud)
 * workspace. The Shell keeps the layout, native caption chrome, mobile drawer,
 * responsive sidebar/panel collapse, global shortcuts, the cheat sheet and the
 * command palette; the workspace controller supplies the data-backed surfaces.
 *
 * Nothing here is a second shell: when `account` is absent the Shell renders
 * exactly the Local markup it always did.
 */
import type { ReactNode } from "react";

/** Drawer and geometry controls the Shell owns. Passed to whichever sidebar
 * the caller renders, so the original `Sidebar` keeps its original props. */
export interface AppShellSidebarControls {
  /** Mobile drawer is open (below md only). */
  open: boolean;
  /** Close the drawer; the Shell returns focus to its menu button. */
  onClose: () => void;
  /** Fold to the avatar rail because a side panel is open and the window
   * cannot seat the sidebar, the chat and the panel together. */
  collapseToIcons: boolean;
}

/** What an account workspace supplies to the shared shell. */
export interface AppShellAccountPort {
  /** The original Sidebar, carrying the workspace/account controls. */
  sidebar: (controls: AppShellSidebarControls) => ReactNode;
  /** The authorized conversation, or its loading/error state, in the main
   * column. The Shell places it exactly where ChatView/GroupView go today. */
  main: ReactNode;
  /** Workspace-scoped side panels and account dialogs, mounted in the same
   * sibling position as the original panels. */
  panels?: ReactNode;
  /** A scoped panel can belong to a bot other than the selected conversation. */
  sidePanelOpen?: boolean;
}
