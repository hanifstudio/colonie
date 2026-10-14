// Real Composio REST provider (v3.1). Injected into the Composio service in
// production; tests supply a fake so no network call or credential is needed.
// The key is only ever sent in the `x-api-key` header, and provider error text
// is passed through `composioKeyRejection`, which redacts the key before it can
// reach a response body or log.
import { composioKeyRejection } from "../connections/key-permissions.ts";
import type { ComposioCallbackResult, ComposioKeyValidation, ComposioLinkStart, ComposioProvider } from "./composio.ts";

export interface HttpComposioProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface CallResult {
  response: Response;
  parsed: unknown;
  text: string;
}

type Call = (apiKey: string, path: string, method: string, body?: unknown) => Promise<CallResult>;

export function httpComposioProvider(options: HttpComposioProviderOptions = {}): ComposioProvider {
  const base = (options.baseUrl ?? process.env.OMB_COMPOSIO_API ?? "https://backend.composio.dev/api/v3.1").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const call: Call = async (apiKey, path, method, body) => {
    const response = await doFetch(`${base}${path}`, {
      method,
      redirect: "error",
      headers: { "x-api-key": apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { response, parsed, text };
  };

  return {
    async validateProjectKey({ apiKey, userId }): Promise<ComposioKeyValidation> {
      let result: CallResult;
      try {
        result = await call(apiKey, "/tool_router/session", "POST", {
          user_id: userId,
          toolkits: { enable: [] },
          sandbox: { enable: false },
          manage_connections: { enable: true, enable_wait_for_connections: false },
        });
      } catch {
        return { ok: false, code: "unavailable", message: "Composio could not be reached to validate this key." };
      }
      if (result.response.ok) {
        const sessionId = (result.parsed as { session_id?: unknown }).session_id;
        return { ok: true, ...(typeof sessionId === "string" ? { sessionId } : {}) };
      }
      const rejection = composioKeyRejection(result.text, result.response.status, apiKey);
      const code = (rejection as { code?: string }).code;
      return {
        ok: false,
        code: code === "composio_session_write_required" ? "session_write_required" : "invalid_key",
        message: rejection.message,
      };
    },

    async provisionProject({ orgKey, name }) {
      // Org-level key auth: `x-org-api-key`, not the project `x-api-key`.
      const response = await doFetch(`${base}/org/owner/project/new`, {
        method: "POST",
        redirect: "error",
        headers: { "x-org-api-key": orgKey, "content-type": "application/json" },
        body: JSON.stringify({ name, should_create_api_key: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Composio project provisioning failed (HTTP ${response.status})`);
      const body = (await response.json().catch(() => ({}))) as { api_key?: unknown; id?: unknown };
      if (typeof body.api_key !== "string" || !body.api_key) throw new Error("Composio did not return a project key.");
      return { apiKey: body.api_key, ...(typeof body.id === "string" ? { projectId: body.id } : {}) };
    },

    async createLink({ apiKey, userId, toolkit, callbackUrl }): Promise<ComposioLinkStart> {
      const authConfigId = await resolveAuthConfigId(call, apiKey, toolkit);
      const result = await call(apiKey, "/connected_accounts/link", "POST", { auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl });
      if (!result.response.ok) throw new Error(`Composio link creation failed (HTTP ${result.response.status})`);
      const body = result.parsed as { redirect_url?: unknown; link_token?: unknown };
      if (typeof body.redirect_url !== "string") throw new Error("Composio did not return a redirect URL.");
      return { redirectUrl: body.redirect_url, ...(typeof body.link_token === "string" ? { linkId: body.link_token } : {}) };
    },

    async verifyCallback({ apiKey, userId, sessionUri }): Promise<ComposioCallbackResult> {
      // Identity is proven only by redeeming the single-use verifier session.
      if (!sessionUri) return { active: false, code: "pending", message: "Waiting for Composio to hand this member's verifier callback back." };
      const result = await call(apiKey, "/connected_accounts/complete_auth", "POST", { session_uri: sessionUri, user_id: userId });
      if (result.response.ok) {
        const body = result.parsed as { connected_account_id?: unknown; toolkit_slug?: unknown };
        const id = typeof body.connected_account_id === "string" ? body.connected_account_id : "";
        if (!id) return { active: false, code: "failed", message: "Composio did not return a connected account." };
        return { active: true, connectedAccountId: id, ...(typeof body.toolkit_slug === "string" ? { toolkit: body.toolkit_slug } : {}) };
      }
      if (result.response.status === 400) return { active: false, code: "identity_mismatch", message: "Composio refused this callback: the connected account does not belong to this member." };
      if (result.response.status === 404) return { active: false, code: "pending", message: "This connection link expired or was already used. Start it again." };
      return { active: false, code: "unavailable", message: "Composio could not complete the connection yet." };
    },
  };
}

/** Find an enabled auth config id for a toolkit so a Connect Link can be minted. */
async function resolveAuthConfigId(call: Call, apiKey: string, toolkit: string): Promise<string> {
  const params = new URLSearchParams({ toolkit_slug: toolkit, limit: "50" });
  const result = await call(apiKey, `/auth_configs?${params}`, "GET");
  if (!result.response.ok) throw new Error(`Composio auth config lookup failed (HTTP ${result.response.status})`);
  const items = (result.parsed as { items?: Array<{ id?: unknown; is_enabled_for_tool_router?: unknown }> }).items ?? [];
  const found = items.find((item) => typeof item.id === "string" && item.is_enabled_for_tool_router !== false);
  if (!found || typeof found.id !== "string") throw new Error(`No Composio auth config is available for ${toolkit}.`);
  return found.id;
}
