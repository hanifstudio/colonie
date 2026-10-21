// The workspaces on this computer, as the profile menu's first section: which
// one runs, which others exist, and how to make another one.
//
// Two facts have to stay apart. One is the workspace this window is running
// now; the other is the one Colonie will run at its next start. In the packaged
// app they are the same, because a change restarts the app. In a source
// checkout the launcher owns the dev server, so a change is recorded and the
// person opens Colonie again — which is why the marked row is the running one
// and the answer says what happens next, instead of moving a tick nobody moved.
import { useEffect, useState } from "react";
import {
  CloudServerIcon,
  ComputerIcon,
  LaptopIcon,
  Loading02Icon,
  PlusSignIcon,
  Tick01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";
import { OPEN_JOIN_SHARED } from "./JoinSharedWorkspace";
import { OPEN_CREATE_SHARED } from "./CreateSharedWorkspace";
import { t } from "@/lib/i18n";
import {
  nameIssueMessage,
  switchNotice,
  switchRefusal,
  workspaceNameIssue,
} from "@/lib/local-workspaces";

export function useLocalWorkspaceItems({ menuOpen }: { menuOpen: boolean }): SidebarMenuItem[] {
  const bridge = typeof window !== "undefined" ? window.colonie?.localWorkspaces : undefined;
  const [state, setState] = useState<LocalWorkspaceState | null>(null);
  /** The workspace this session actually started with. A choice made here is
   * what the next start uses, which is not the same thing until it restarts. */
  const [runningId, setRunningId] = useState<string | null>(null);
  /** The new-workspace form: first the kind, then (Local) its name. */
  const [creating, setCreating] = useState<false | "choose" | "local">(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .list()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setRunningId((current) => current ?? next.activeId);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bridge]);

  // A form half filled and answers about a restart are about the visit, not the
  // app: closing the menu puts them away rather than surprising the next visit.
  useEffect(() => {
    if (menuOpen) return;
    setCreating(false);
    setName("");
    setError("");
    setNotice("");
  }, [menuOpen]);

  const choose = async (workspace: LocalWorkspace) => {
    if (!bridge || busy) return;
    setBusy(workspace.id);
    setError("");
    setNotice("");
    try {
      const result = await bridge.switch(workspace.id);
      if (!result.ok) {
        setError(switchRefusal(result.code, result.message));
        return;
      }
      if (result.state) setState(result.state);
      setNotice(switchNotice(result.mode, workspace.name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    if (!bridge || busy || !state) return;
    const issue = workspaceNameIssue(name, state.nameMax);
    if (issue) {
      setError(nameIssueMessage(issue, state.nameMax));
      return;
    }
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const created = await bridge.create(name.trim());
      if (!created.ok) {
        setError(created.message);
        return;
      }
      setState(created.state);
      setName("");
      setCreating(false);
      // A workspace is made to be used, so it opens right away. If that half
      // fails the creation still stands, and both facts are said out loud.
      const result = await bridge.switch(created.workspace.id);
      if (!result.ok) {
        setNotice(t("sidebar.workspace.created", { name: created.workspace.name }));
        setError(switchRefusal(result.code, result.message));
        return;
      }
      if (result.state) setState(result.state);
      setNotice(switchNotice(result.mode, created.workspace.name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const items: SidebarMenuItem[] = [];
  if (!bridge || !state) return items;

  if (creating === "choose") {
    items.push(
      {
        key: "workspace-kind-local",
        heading: t("sidebar.workspace.newHeading"),
        label: "Local",
        note: t("sidebar.workspace.localNote"),
        icon: <HIcon icon={ComputerIcon} size={18} />,
        keepOpen: true,
        onSelect: () => { setCreating("local"); setError(""); },
      },
      {
        key: "workspace-kind-server",
        label: "Shared",
        note: t("sidebar.workspace.serverNote"),
        icon: <HIcon icon={CloudServerIcon} size={18} />,
        disabled: !window.colonie?.environments,
        onSelect: () => {
          window.dispatchEvent(new Event(OPEN_CREATE_SHARED));
          setCreating(false);
        },
      },
      {
        key: "workspace-cancel",
        label: t("common.cancel"),
        separatorBefore: true,
        onSelect: () => { setCreating(false); setName(""); setError(""); },
      },
    );
    return items;
  }

  if (creating === "local") {
    const issue = workspaceNameIssue(name, state.nameMax);
    items.push(
      {
        key: "workspace-name",
        heading: "New Local workspace",
        custom: (
          <input
            autoFocus
            value={name}
            maxLength={state.nameMax}
            aria-label={t("sidebar.workspace.nameLabel")}
            placeholder={t("sidebar.workspace.namePlaceholder")}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            className="mb-1 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none"
          />
        ),
        onSelect: () => {},
      },
      {
        key: "workspace-create",
        label: busy === "create" ? t("sidebar.workspace.creating") : t("sidebar.workspace.create"),
        icon: busy === "create"
          ? <HIcon icon={Loading02Icon} size={18} className="animate-spin" />
          : <HIcon icon={PlusSignIcon} size={18} />,
        disabled: busy !== "" || issue !== "",
        keepOpen: true,
        separatorBefore: true,
        onSelect: () => void create(),
      },
      {
        key: "workspace-cancel",
        label: t("common.cancel"),
        disabled: busy !== "",
        onSelect: () => { setCreating(false); setName(""); setError(""); },
      },
      ...(error
        ? [{
            key: "workspace-error",
            custom: <p role="alert" className="pb-1 text-[11.5px] leading-snug text-danger">{error}</p>,
            onSelect: () => {},
          }]
        : []),
    );
    return items;
  }

  const running = runningId ?? state.activeId;
  state.workspaces.forEach((workspace, index) => {
    const isRunning = workspace.id === running;
    items.push({
      key: `workspace-${workspace.id}`,
      label: workspace.name,
      ...(index === 0 ? { heading: t("sidebar.workspace.heading") } : {}),
      icon: <HIcon icon={LaptopIcon} size={18} />,
      active: isRunning,
      note: isRunning ? t("sidebar.workspace.openNow") : undefined,
      trailing: isRunning
        ? <HIcon icon={Tick01Icon} size={15} className="shrink-0 text-success" aria-hidden="true" />
        : busy === workspace.id
          ? <HIcon icon={Loading02Icon} size={16} className="animate-spin" />
          : undefined,
      // The one already running has nothing to do and nothing to say, so it
      // closes the menu like any other plain choice; the others report in place.
      disabled: busy !== "",
      keepOpen: !isRunning,
      onSelect: () => void choose(workspace),
    });
  });
  items.push({
    key: "workspace-new",
    label: t("sidebar.workspace.new"),
    icon: <HIcon icon={PlusSignIcon} size={18} />,
    disabled: busy !== "",
    // Opening the name form is the start of something, not a choice: closing
    // the menu here would put the form away again before it was drawn.
    keepOpen: true,
    onSelect: () => { setCreating("choose"); setError(""); setNotice(""); },
  });
  if (window.colonie?.environments) {
    items.push({
      key: "workspace-join-shared",
      label: "Join a Shared workspace",
      icon: <HIcon icon={UserGroupIcon} size={18} />,
      disabled: busy !== "",
      onSelect: () => window.dispatchEvent(new Event(OPEN_JOIN_SHARED)),
    });
  }
  if (notice) {
    items.push({
      key: "workspace-notice",
      custom: <p role="status" className="pb-1 pt-0.5 text-[11.5px] leading-snug text-ink-tertiary">{notice}</p>,
      onSelect: () => {},
    });
  }
  if (error) {
    items.push({
      key: "workspace-error",
      custom: <p role="alert" className="pb-1 pt-0.5 text-[11.5px] leading-snug text-danger">{error}</p>,
      onSelect: () => {},
    });
  }
  return items;
}
