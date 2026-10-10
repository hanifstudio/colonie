import { expect, it } from "vitest";
import { composioCredentialStatus } from "./credential-status.ts";
import { credentialOperationError, maskedComposioKey } from "../../../shared/composio-credential.ts";

it("distinguishes project keys from broker availability and returns masked source-specific metadata", () => {
  expect(composioCredentialStatus({}, { OMB_COMPOSIO_BROKER_TOKEN: "synthetic" })).toMatchObject({ available: false, source: "none", maskedKey: null, canRemove: false });
  const key = "ak_synthetic_fixture_1234";
  expect(composioCredentialStatus({ composio: { apiKey: key } }, {})).toMatchObject({ available: true, source: "workspace-settings", maskedKey: "ak_syn••••••••1234", canRemove: true });
  expect(composioCredentialStatus({ composio: { apiKey: key } }, { COMPOSIO_API_KEY: key })).toMatchObject({ source: "environment", canRemove: false });
  expect(composioCredentialStatus({ composio: { apiKey: key } }, { COMPOSIO_API_KEY: key, COLONIE_COMPOSIO_CREDENTIAL_SOURCE: "secure-store" })).toMatchObject({ source: "secure-store", canRemove: true });
  expect(composioCredentialStatus({ composio: { apiKey: key } }, { COMPOSIO_API_KEY: key, COLONIE_COMPOSIO_CREDENTIAL_SOURCE: "secure-store", COLONIE_COMPOSIO_CREDENTIAL_ORIGIN: "workspace-migration" })).toMatchObject({ origin: "workspace-migration" });
  expect(JSON.stringify(composioCredentialStatus({ composio: { apiKey: key } }, {}))).not.toContain(key);
  expect(maskedComposioKey("ak_short")).toBe("••••••••");
  expect(composioCredentialStatus({ composio: { apiKey: key } }, { OMB_CREDENTIAL_STORE: "unavailable" })).toMatchObject({ storage: "unreadable", canRemove: false });
});

it("preserves real IPC failure reasons and says removal failed rather than not saved", () => {
  const crypto = new Error("Error invoking remote method 'credential:set': Error: Error while encrypting the text provided to safeStorage.encryptStringAsync.");
  expect(credentialOperationError(crypto, "remove")).toContain("could not be removed");
  expect(credentialOperationError(crypto, "remove")).toContain("still active");
  expect(credentialOperationError(crypto, "save")).toContain("could not be saved");
  const rejected = new Error("Error invoking remote method 'credential:set': Error: Composio rejected this key (HTTP 401)");
  expect(credentialOperationError(rejected, "save")).toContain("HTTP 401");
  expect(credentialOperationError(rejected, "save")).not.toContain("macOS");
});
