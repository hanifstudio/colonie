// Public surface of the Colonie platform shell. `PlatformApp` is the one entry
// the desktop/web integration mounts; everything else is a sub-panel it owns.
export { PlatformApp, default } from "./PlatformApp";
export type { PlatformAppProps } from "./PlatformApp";
export { AuthScreen } from "./AuthScreen";
export { WorkspaceChooser } from "./WorkspaceChooser";
export { WorkspaceShell } from "./WorkspaceShell";
export { ConversationView } from "./ConversationView";
export { MembersPanel } from "./MembersPanel";
export { WorkspaceSettings } from "./WorkspaceSettings";
export { BotDialog, DmDialog, GroupDialog } from "./ComposerDialogs";
