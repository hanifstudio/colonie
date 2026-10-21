// Sign in with Colonie, the way a Shared workspace uses it: register, send the
// person to /authorize with PKCE, get a code back at the registered address,
// swap it at /token for an ID token, and verify that token with the published
// key. Then every way it must refuse.
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, expect, test } from "vitest";

import { ORIGIN, testCloud } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

const WORKSPACE_CALLBACK = "https://203-0-113-5.sslip.io/auth/colonie/callback";
const ADA = { name: "Ada Lovelace", email: "ada@example.com", password: "correct horse battery" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function setup(options: { now?: () => Date } = {}) {
  const cloud = await testCloud(options);
  closers.push(() => cloud.db.close());
  const registered = await cloud.request("/clients", { json: { name: "Launch Team", redirect_uri: WORKSPACE_CALLBACK } });
  expect(registered.response.status).toBe(201);
  const clientId = JSON.parse(registered.text).client_id as string;
  const cookie = cloud.cookieFrom((await cloud.request("/signup", { form: ADA })).response)!;
  return { ...cloud, clientId, cookie };
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: WORKSPACE_CALLBACK,
    state: "state-123", code_challenge: challenge, code_challenge_method: "S256", nonce: "nonce-456", ...extra,
  }).toString();
}

/** Approve on the consent page; the code and state that come back. */
async function approve(s: Awaited<ReturnType<typeof setup>>, challenge: string) {
  const fields = Object.fromEntries(new URLSearchParams(authorizeQuery(s.clientId, challenge)));
  const { response } = await s.request("/authorize", { form: fields, cookie: s.cookie });
  expect(response.status).toBe(303);
  const back = new URL(response.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(WORKSPACE_CALLBACK);
  return { code: back.searchParams.get("code")!, state: back.searchParams.get("state") };
}

const exchange = (s: Awaited<ReturnType<typeof setup>>, code: string, verifier: string, overrides: Record<string, string> = {}) =>
  s.request("/token", {
    form: { grant_type: "authorization_code", code, client_id: s.clientId, redirect_uri: WORKSPACE_CALLBACK, code_verifier: verifier, ...overrides },
    origin: "",
  });

test("the whole flow ends in an ID token the workspace can verify", async () => {
  const s = await setup();
  const { verifier, challenge } = pkce();
  const consent = await s.request(`/authorize?${authorizeQuery(s.clientId, challenge)}`, { cookie: s.cookie });
  expect(consent.text).toContain("Launch Team");
  expect(consent.text).toContain("203-0-113-5.sslip.io");
  expect(consent.text).toContain("Ada Lovelace");
  const { code, state } = await approve(s, challenge);
  expect(state).toBe("state-123");
  const token = await exchange(s, code, verifier);
  expect(token.response.status).toBe(200);
  const body = JSON.parse(token.text);
  const jwks = createLocalJWKSet(JSON.parse((await s.request("/.well-known/jwks.json")).text));
  const { payload, protectedHeader } = await jwtVerify(body.id_token, jwks, { issuer: ORIGIN, audience: s.clientId });
  expect(protectedHeader.alg).toBe("ES256");
  expect(payload).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace", nonce: "nonce-456", email_verified: false });
  expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/);
  expect(payload.exp! - payload.iat!).toBe(300);
});

test("someone not signed in is sent to sign in, then back to the same request", async () => {
  const s = await setup();
  const { challenge } = pkce();
  const { response } = await s.request(`/authorize?${authorizeQuery(s.clientId, challenge)}`);
  expect(response.status).toBe(303);
  const signin = new URL(response.headers.get("location")!, ORIGIN);
  expect(signin.pathname).toBe("/signin");
  expect(signin.searchParams.get("next")).toBe(`/authorize?${authorizeQuery(s.clientId, challenge)}`);
});

test("a code works once, only with its verifier, its client, and its address", async () => {
  const s = await setup();
  const { verifier, challenge } = pkce();
  const wrongVerifier = await exchange(s, (await approve(s, challenge)).code, pkce().verifier);
  expect(wrongVerifier.response.status).toBe(400);
  const { code } = await approve(s, challenge);
  expect((await exchange(s, code, verifier, { client_id: "ws_other" })).response.status).toBe(400);
  const { code: another } = await approve(s, challenge);
  expect((await exchange(s, another, verifier, { redirect_uri: "https://evil.example/cb" })).response.status).toBe(400);
  const { code: good } = await approve(s, challenge);
  expect((await exchange(s, good, verifier)).response.status).toBe(200);
  expect((await exchange(s, good, verifier)).response.status).toBe(400);
});

test("a code expires after a minute", async () => {
  let clock = new Date("2026-10-21T10:00:00Z");
  const s = await setup({ now: () => clock });
  const { verifier, challenge } = pkce();
  const { code } = await approve(s, challenge);
  clock = new Date(clock.getTime() + 61_000);
  expect((await exchange(s, code, verifier)).response.status).toBe(400);
});

test("an unknown workspace or a different address gets an error page, never a redirect", async () => {
  const s = await setup();
  const { challenge } = pkce();
  for (const query of [
    authorizeQuery("ws_unknown", challenge),
    authorizeQuery(s.clientId, challenge, { redirect_uri: "https://evil.example/cb" }),
    authorizeQuery(s.clientId, challenge, { redirect_uri: `${WORKSPACE_CALLBACK}/extra` }),
  ]) {
    const { response } = await s.request(`/authorize?${query}`, { cookie: s.cookie });
    expect(response.status, query).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  }
});

test("a request without PKCE goes back to the workspace as an error", async () => {
  const s = await setup();
  const broken: Array<Record<string, string>> = [{ code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }];
  for (const extra of broken) {
    const { response } = await s.request(`/authorize?${authorizeQuery(s.clientId, pkce().challenge, extra)}`, { cookie: s.cookie });
    const back = new URL(response.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("code")).toBeNull();
  }
});

test("a workspace must register a safe address", async () => {
  const s = await setup();
  for (const redirect_uri of ["http://203.0.113.5/cb", "not a url", "https://x.example/cb#frag", "https://user:pw@x.example/cb"]) {
    expect((await s.request("/clients", { json: { name: "W", redirect_uri } })).response.status, redirect_uri).toBe(400);
  }
  expect((await s.request("/clients", { json: { name: "", redirect_uri: WORKSPACE_CALLBACK } })).response.status).toBe(400);
  expect((await s.request("/clients", { json: { name: "Dev", redirect_uri: "http://localhost:8799/cb" } })).response.status).toBe(201);
});

test("the discovery document names the endpoints and the key", async () => {
  const s = await setup();
  const config = JSON.parse((await s.request("/.well-known/openid-configuration")).text);
  expect(config).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/token`, jwks_uri: `${ORIGIN}/.well-known/jwks.json`, code_challenge_methods_supported: ["S256"] });
  const jwks = JSON.parse((await s.request("/.well-known/jwks.json")).text);
  expect(jwks.keys).toHaveLength(1);
  expect(jwks.keys[0].d).toBeUndefined();
  expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", kid: "test-key" });
});
