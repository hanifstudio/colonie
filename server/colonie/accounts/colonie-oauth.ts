// The one exchange every Colonie account sign-in ends with: trade the code
// for an ID token at Colonie Cloud (PKCE), and check that token against the
// Cloud's published keys, this client, and the sign-in's nonce. Used by a
// Shared workspace's sign-in and by the desktop app's own account.
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface ColonieAccount { sub: string; email: string; name: string }

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifiedColonieAccount(input: {
  http: typeof fetch;
  issuer: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  nonce: string;
}): Promise<ColonieAccount | null> {
  const answer = await input.http(`${input.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, client_id: input.clientId, redirect_uri: input.redirectUri, code_verifier: input.verifier }).toString(),
  });
  if (!answer.ok) return null;
  const { id_token: idToken } = await answer.json() as { id_token?: string };
  if (!idToken) return null;
  let keys = keySets.get(input.issuer);
  if (!keys) keySets.set(input.issuer, keys = createRemoteJWKSet(new URL(`${input.issuer}/.well-known/jwks.json`)));
  const { payload } = await jwtVerify(idToken, keys, { issuer: input.issuer, audience: input.clientId, algorithms: ["ES256"] });
  if (payload.nonce !== input.nonce || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
  return { sub: payload.sub, email: payload.email.trim().toLowerCase(), name: typeof payload.name === "string" ? payload.name : payload.email };
}
