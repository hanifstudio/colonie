// Print a fresh ES256 signing key for Colonie Cloud, as the JSON to store with
// `wrangler secret put SIGNING_JWK`. Run it, paste the output into that
// command, and keep no other copy. The public half is published by the
// service itself (/.well-known/jwks.json).
import { generateSigningJwk } from "../src/oauth.ts";

console.log(JSON.stringify(await generateSigningJwk()));
