// The desktop owner's Shared workspace servers, as the app asks this
// computer's server about them (server/colonie/deploy/shared-servers.ts).
// Used by the Shared workspace onboarding and the servers list.
import { api } from "@/state/store";

export interface SharedServer {
  id: string; name: string; tag: string; region: string; size: string;
  kind?: "digitalocean" | "self"; command?: string;
  state: "creating" | "starting" | "ready" | "failed";
  createdAt: string; address?: string; inviteUrl?: string; opened?: boolean; error?: string;
}

export interface SharedServersState {
  digitalOcean: {
    connected: boolean; region: string; size: string; error?: string;
    account?: { email: string; dropletLimit: number; active: boolean };
    price?: { monthlyUsd: number; hourlyUsd: number };
  };
  servers: SharedServer[];
}

export const loadSharedServers = () => api<SharedServersState>("/api/shared-servers");

/** Start connecting DigitalOcean: the sign-in opens in the system browser. */
export async function connectDigitalOcean(): Promise<void> {
  const { authorizationUrl } = await api<{ authorizationUrl: string }>("/api/shared-servers/digitalocean/connect", { method: "POST" });
  window.open(authorizationUrl, "_blank", "noopener");
}

export const createOnDigitalOcean = (name: string) =>
  api<SharedServer>("/api/shared-servers", { method: "POST", body: JSON.stringify({ name: name.trim() }) });

export const createOnOwnServer = (name: string, address: string) =>
  api<SharedServer>("/api/shared-servers/self", { method: "POST", body: JSON.stringify({ name: name.trim(), address: address.trim() }) });

/** The first open signs the owner in with their invite; later ones open the address. */
export async function openShared(
  bridge: { addFromLink: (link: string, name?: string) => Promise<boolean | void> },
  markOpened: (id: string) => Promise<void>,
  server: SharedServer,
): Promise<boolean> {
  const link = !server.opened && server.inviteUrl ? server.inviteUrl : server.address;
  if (!link) return false;
  const joined = (await bridge.addFromLink(link, server.name)) !== false;
  if (joined && !server.opened) await markOpened(server.id);
  return joined;
}

export const markSharedOpened = async (id: string) => { await api(`/api/shared-servers/${id}/opened`, { method: "POST" }); };
