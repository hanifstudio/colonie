// Beats of the Shared workspace onboarding. On this computer: a name, where
// its server runs (one click on DigitalOcean, or the owner's own server), and
// the wait while it starts, ending in Open. Inside the new workspace: an
// invite step between connecting AI on the server and meeting the bot. Each
// beat has a plain view (tested) and the part that talks to the server.
import { useCallback, useEffect, useState } from "react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "../../HIcon";
import { InviteLink, createInviteLink, type Invite } from "../../ColoniePeople";
import { PasteCommand } from "../../CreateSharedWorkspace";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import {
  connectDigitalOcean, createOnDigitalOcean, createOnOwnServer, loadSharedServers, markSharedOpened, openShared,
  type SharedServer, type SharedServersState,
} from "@/lib/shared-servers";
import { inputClass, PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

const REGIONS: Record<string, string> = { sgp1: "Singapore" };
const SIZES: Record<string, string> = { "s-2vcpu-4gb": "2 CPUs, 4 GB memory" };
const say = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// ── a name ──────────────────────────────────────────────────────────────

export function SharedNameBeat({ onNext, name, onName }: BeatProps & { name: string; onName: (name: string) => void }) {
  return (
    <form className="stagger flex flex-col" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onNext(); }}>
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary" style={staggerIndex(0)}>
        Name your Shared workspace. It runs on a server you own, for you, the people you invite, and your bots.
      </p>
      <input autoFocus value={name} onChange={(event) => onName(event.target.value)} maxLength={60} aria-label="Workspace name"
        placeholder="Launch Team" className={cn(inputClass, "animate-rise mt-4")} style={staggerIndex(1)} />
      <PrimaryButton type="submit" disabled={!name.trim()} className="animate-rise mt-5" style={staggerIndex(2)}>Continue</PrimaryButton>
    </form>
  );
}

// ── where its server runs ───────────────────────────────────────────────

export type SetupMode = "digitalocean" | "self";

export function SharedWhereBeatView({ mode, ocean, address, busy, error, waitingForBrowser, onMode, onAddress, onConnect, onCreate }: {
  mode: SetupMode;
  ocean: SharedServersState["digitalOcean"] | null;
  address: string;
  busy: string;
  error: string;
  waitingForBrowser: boolean;
  onMode: (mode: SetupMode) => void;
  onAddress: (address: string) => void;
  onConnect: () => void;
  onCreate: () => void;
}) {
  const spinner = (label: string) => busy === label && <HIcon icon={Loading02Icon} size={14} className="mr-1.5 inline animate-spin" />;
  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">Where should its server run?</p>
      <div role="radiogroup" aria-label="Where it runs" className="mt-4 grid grid-cols-2 gap-2.5">
        {([["digitalocean", "One click on DigitalOcean", "A new server in your DigitalOcean account."], ["self", "My own server", "A server you already have, with Ubuntu."]] as const).map(([value, label, detail]) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => onMode(value)}
            className={cn("rounded-xl border bg-card p-3.5 text-left", mode === value ? "border-accent/50" : "border-hairline/40 hover:border-hairline")}>
            <span className="block text-[14px] font-medium text-ink">{label}</span>
            <span className="mt-0.5 block text-[12.5px] text-ink-secondary">{detail}</span>
          </button>
        ))}
      </div>

      {mode === "digitalocean" && ocean && !ocean.connected && (
        <div className="mt-4">
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            {waitingForBrowser
              ? "Finish connecting in your browser. This continues by itself when you are done."
              : "Your browser opens DigitalOcean, where you sign in or create an account and allow Colonie to create and delete its own servers."}
          </p>
          <PrimaryButton className="mt-4" disabled={busy !== ""} onClick={onConnect}>{spinner("connect")}Connect DigitalOcean</PrimaryButton>
        </div>
      )}
      {mode === "digitalocean" && ocean?.connected && (
        <div className="mt-4">
          <p className="text-[13px] text-ink">
            {REGIONS[ocean.region] ?? ocean.region} · {SIZES[ocean.size] ?? ocean.size}
            {ocean.price && <> · <strong>${ocean.price.monthlyUsd} a month</strong></>}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            Billed by DigitalOcean{ocean.account ? ` (${ocean.account.email})` : ""} until you delete it, also while it is switched off.
          </p>
          {ocean.error && <p className="mt-2 text-[12px] text-danger">{ocean.error}</p>}
          <PrimaryButton className="mt-4" disabled={busy !== ""} onClick={onCreate}>{spinner("create")}Create the server</PrimaryButton>
        </div>
      )}
      {mode === "self" && (
        <div className="mt-4">
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            Your server needs Ubuntu 22.04 or 24.04, at least 2 CPUs and 4 GB of memory, ports 80 and 443 open, and about
            10 GB free. Enter its public IP address or domain name that points to it.
          </p>
          <input value={address} onChange={(event) => onAddress(event.target.value)} aria-label="Server IP address or domain"
            placeholder="203.0.113.9 or team.example.com" className={cn(inputClass, "mt-3")} />
          <PrimaryButton className="mt-4" disabled={busy !== "" || !address.trim()} onClick={onCreate}>{spinner("create")}Get the command</PrimaryButton>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}

export function SharedWhereBeat({ name, onCreated }: { name: string; onCreated: (server: SharedServer) => void }) {
  const [mode, setMode] = useState<SetupMode>("digitalocean");
  const [ocean, setOcean] = useState<SharedServersState["digitalOcean"] | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [waitingForBrowser, setWaitingForBrowser] = useState(false);
  const load = useCallback(async () => {
    try { setOcean((await loadSharedServers()).digitalOcean); } catch (cause) { setError(say(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!waitingForBrowser) return;
    const timer = setInterval(() => void load(), 2_500);
    return () => clearInterval(timer);
  }, [waitingForBrowser, load]);
  useEffect(() => { if (ocean?.connected) setWaitingForBrowser(false); }, [ocean?.connected]);
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError("");
    try { await action(); } catch (cause) { setError(say(cause)); } finally { setBusy(""); }
  };
  return (
    <SharedWhereBeatView mode={mode} ocean={ocean} address={address} busy={busy} error={error} waitingForBrowser={waitingForBrowser}
      onMode={setMode} onAddress={setAddress}
      onConnect={() => void run("connect", async () => { await connectDigitalOcean(); setWaitingForBrowser(true); })}
      onCreate={() => void run("create", async () => {
        onCreated(mode === "self" ? await createOnOwnServer(name, address) : await createOnDigitalOcean(name));
      })} />
  );
}

// ── the wait, then Open ─────────────────────────────────────────────────

export function SharedReadyBeatView({ server, busy, error, onOpen }: { server: SharedServer | null; busy: boolean; error: string; onOpen: () => void }) {
  if (!server) return <p className="mt-2 text-[13px] text-ink-secondary"><HIcon icon={Loading02Icon} size={14} className="mr-1.5 inline animate-spin" />Checking…</p>;
  const host = server.address?.replace(/^https:\/\//, "") ?? "";
  const progress = server.kind === "self"
    ? `Waiting for ${host} to answer. This takes a few minutes after the command finishes.`
    : server.state === "creating" ? "Creating the server on DigitalOcean…" : "Starting Colonie on the server. The first start takes a few minutes.";
  return (
    <div className="flex flex-col">
      {server.state === "failed" ? (
        <p role="alert" className="mt-1 text-[13px] text-danger">{server.error}</p>
      ) : server.state === "ready" ? (
        <>
          <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">
            Your Shared workspace is ready at {host}. Open it and sign in as its first admin; then connect AI on the server and invite people.
          </p>
          <PrimaryButton className="animate-rise mt-5" disabled={busy} onClick={onOpen}>
            {busy && <HIcon icon={Loading02Icon} size={14} className="mr-1.5 inline animate-spin" />}Open {server.name}
          </PrimaryButton>
        </>
      ) : (
        <>
          <p className="animate-rise mt-1 flex items-start gap-2 text-[13.5px] text-ink-secondary">
            <HIcon icon={Loading02Icon} size={15} className="mt-0.5 shrink-0 animate-spin" />{progress}
          </p>
          {server.kind === "self" && server.command && <div className="mt-3"><PasteCommand command={server.command} /></div>}
        </>
      )}
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}

export function SharedReadyBeat({ serverId, onOpened }: { serverId: string; onOpened: () => void }) {
  const [server, setServer] = useState<SharedServer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setServer((await loadSharedServers()).servers.find((entry) => entry.id === serverId) ?? null); } catch (cause) { setError(say(cause)); }
  }, [serverId]);
  useEffect(() => { void load(); }, [load]);
  const waiting = !server || server.state === "creating" || server.state === "starting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [waiting, load]);
  const open = async () => {
    const bridge = window.colonie?.environments;
    if (!bridge || !server) return;
    setBusy(true); setError("");
    try {
      if (await openShared(bridge, markSharedOpened, server)) onOpened();
    } catch (cause) { setError(say(cause)); } finally { setBusy(false); }
  };
  return <SharedReadyBeatView server={server} busy={busy} error={error} onOpen={() => void open()} />;
}

// ── inside the workspace: invite people ────────────────────────────────

export function InviteBeatView({ onNext, onSkip, invite, busy, error, onCreate }: BeatProps & { invite: Invite | null; busy: boolean; error: string; onCreate: () => void }) {
  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">
        Invite people to work here with you and your bots. Send the link yourself; it works once, and they sign in with a Colonie account.
      </p>
      {invite ? <InviteLink invite={invite} /> : (
        <PrimaryButton className="animate-rise mt-5" disabled={busy} onClick={onCreate}>
          {busy && <HIcon icon={Loading02Icon} size={14} className="mr-1.5 inline animate-spin" />}Create invite link
        </PrimaryButton>
      )}
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
      <div className="mt-4 flex justify-center">
        {invite ? <PrimaryButton onClick={onNext}>Continue</PrimaryButton> : <QuietButton onClick={onSkip}>Skip for now</QuietButton>}
      </div>
    </div>
  );
}

export function InviteBeat(props: BeatProps) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true); setError("");
    try { setInvite(await createInviteLink(api, "member")); } catch (cause) { setError(say(cause)); } finally { setBusy(false); }
  };
  return <InviteBeatView {...props} invite={invite} busy={busy} error={error} onCreate={() => void create()} />;
}
