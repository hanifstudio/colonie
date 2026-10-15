// Workspace settings: the workspace name, and this workspace's apps. App setup
// belongs to owners and admins and happens through the workspace's own Composio
// project; nothing here asks a member for a raw provider key.
import { useCallback, useRef, useState } from "react";
import { Button, Field, Notice, TextInput } from "./ui";
import { SettingsModal } from "@/components/SettingsModal";
import { Card } from "@/components/SettingsPrimitives";
import { BotEditorStore, useStore, type Action, type AppSettingsSection } from "@/state/store";
import { ConnectedApps } from "./ConnectedApps";
import { roleLabel, type PlatformClient, type PlatformWorkspace } from "@/lib/colonie-platform";

export function WorkspaceSettings(props: WorkspaceSettingsProps) {
  return props.open ? <OpenWorkspaceSettings key={props.workspace.id} {...props} /> : null;
}

interface WorkspaceSettingsProps {
  open: boolean;
  onClose: () => void;
  workspace: PlatformWorkspace;
  client: PlatformClient;
  canRename: boolean;
  canManageApps: boolean;
  onRename: (name: string) => Promise<void>;
}

function OpenWorkspaceSettings({
  onClose,
  workspace,
  client,
  canRename,
  canManageApps,
  onRename,
}: WorkspaceSettingsProps) {
  const parent = useStore();
  const parentDispatch = useRef(parent.dispatch);
  parentDispatch.current = parent.dispatch;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [section, setSection] = useState<AppSettingsSection>(parent.state.appSettingsSection);
  const dispatch = useCallback((action: Action) => {
    if (action.type !== "toggleAppSettings") return;
    if (action.open === false) closeRef.current();
    else if (action.section) { setSection(action.section); parentDispatch.current(action); }
  }, []);
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change was not saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <BotEditorStore value={{ ...parent, state: { ...parent.state, appSettingsSection: section }, dispatch }}>
    <SettingsModal workspace={{ general: <Card title="Workspace" subtitle={`${workspace.kind === "cloud" ? "Cloud" : "Local"} workspace · you are ${roleLabel(workspace.myRole)}`}>
      <div className="space-y-6">
        {error && <Notice tone="error">{error}</Notice>}

        <section className="space-y-2">
          <Field label="Workspace name" hint={canRename ? undefined : "Only owners and admins can rename this workspace."}>
            <div className="flex items-end gap-2">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={!canRename} onFocus={() => setSaved(false)} />
              {canRename ? (
                <Button
                  variant="secondary"
                  busy={busy === "rename"}
                  disabled={!name.trim() || name.trim() === workspace.name}
                  onClick={() => void run("rename", async () => { await onRename(name.trim()); setSaved(true); })}
                >
                  {saved ? "Saved" : "Save"}
                </Button>
              ) : null}
            </div>
          </Field>
        </section>

      </div>
    </Card>, connections: <ConnectedApps workspaceId={workspace.id} canManage={canManageApps} client={client} /> }} />
    </BotEditorStore>
  );
}
