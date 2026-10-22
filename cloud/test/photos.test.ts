// A photo on the Colonie account: set once at Colonie Cloud, shown by every
// workspace from /photos/<account id>.
import { afterEach, expect, test } from "vitest";

import { PHOTO_MAX_BASE64 } from "../src/photos.ts";
import { testCloud } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function signedIn() {
  const made = await testCloud();
  closers.push(() => made.db.close());
  const { response } = await made.request("/signup", { form: { name: "Ada", email: "ada@example.com", password: "correct horse battery" } });
  const cookie = made.cookieFrom(response)!;
  const [account] = await made.db.query<{ id: string }>("select id from colonie_cloud.accounts");
  return { ...made, cookie, id: account!.id };
}
// the start of a real JPEG, as the photo page sends it
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64")}`;

test("the photo page asks to sign in first, then offers to choose a picture with its one allowed script", async () => {
  const { request, cookie } = await signedIn();
  const anonymous = await request("/photo");
  expect(anonymous.response.status).toBe(303);
  expect(anonymous.response.headers.get("location")).toBe("/signin?next=/photo");
  const { response, text } = await request("/photo", { cookie });
  expect(response.status).toBe(200);
  expect(text).toContain("Choose a picture");
  const nonce = /<script nonce="(\w+)">/.exec(text)?.[1];
  expect(nonce).toBeTruthy();
  expect(response.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
  expect(text).not.toContain("Remove photo");
});

test("a saved photo is served to anyone by account id, and can be removed", async () => {
  const { request, cookie, id } = await signedIn();
  expect((await request(`/photos/${id}`)).response.status).toBe(404);
  const saved = await request("/photo", { cookie, form: { photo: JPEG } });
  expect(saved.response.status).toBe(200);
  expect(saved.text).toContain("Saved.");
  expect(saved.text).toContain("Remove photo");
  const served = await request(`/photos/${id}`);
  expect(served.response.status).toBe(200);
  expect(served.response.headers.get("content-type")).toBe("image/jpeg");
  expect(served.response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect((await request("/photo", { cookie, form: { remove: "1" } })).text).toContain("Photo removed.");
  expect((await request(`/photos/${id}`)).response.status).toBe(404);
});

test("only a small JPEG from the photo page is kept, and only for the signed-in account", async () => {
  const { request, cookie, id } = await signedIn();
  for (const photo of ["data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,PHN2Zz4=", `data:image/jpeg;base64,/9j/${"A".repeat(PHOTO_MAX_BASE64)}`, "javascript:alert(1)"]) {
    const { response } = await request("/photo", { cookie, form: { photo } });
    expect(response.status).toBe(400);
  }
  expect((await request(`/photos/${id}`)).response.status).toBe(404);
  const anonymous = await request("/photo", { form: { photo: JPEG } });
  expect(anonymous.response.status).toBe(303);
  expect((await request(`/photos/${id}`)).response.status).toBe(404);
  // from another site, refused before anything is read
  expect((await request("/photo", { cookie, form: { photo: JPEG }, origin: "https://evil.example" })).response.status).toBe(403);
});
