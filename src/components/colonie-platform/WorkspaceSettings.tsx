// Workspace settings: the workspace name, and this workspace's apps. App setup
// belongs to owners and admins and happens through the workspace's own Composio
// project; nothing here asks a member for a raw provider key.
import { useState } from "react";
import { Button, Field, Modal, Notice, TextInput } from "./ui";
import { ConnectedApps } from "./ConnectedApps";
import { roleLabel, type PlatformClient, type PlatformWorkspace } from "@/lib/colonie-platform";

export function WorkspaceSettings({
  open,
  onClose,
  workspace,
  client,
  canRename,
  canManageApps,
  onRename,
}: {
  open: boolean;
  onClose: () => void;
  workspace: PlatformWorkspace;
  client: PlatformClient;
  canRename: boolean;
  canManageApps: boolean;
  onRename: (name: string) => Promise<void>;
}) {
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
    <Modal open={open} onClose={onClose} title="Workspace settings" description={`${workspace.kind === "cloud" ? "Cloud" : "Local"} workspace · you are ${roleLabel(workspace.myRole)}`} wide>
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

        {open ? <ConnectedApps workspaceId={workspace.id} canManage={canManageApps} client={client} /> : null}
      </div>
    </Modal>
  );
}
