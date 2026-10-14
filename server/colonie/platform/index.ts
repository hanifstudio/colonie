// Public surface of the Colonie Cloud platform core. The lead's host.ts mounts
// `createPlatformApp`; runtime.ts implements `BotRuntime` and receives the app's
// `service` as its `PlatformTurnSink`.
export { createPlatformApp, type PlatformApp } from "./app.ts";
export { PlatformService, type PlatformServiceConfig, mentionsBot } from "./service.ts";
export { createPlatformRoutes } from "./routes.ts";
export { StreamHub, type AuthorizeFrame, type StreamDelivery } from "./events.ts";
export { SecretBox, maskSecret, generateSecretKey, type SealedSecret } from "./secrets.ts";
export {
  WorkspaceComposioService,
  personalComposioUserId,
  serviceComposioUserId,
  platformAccess,
  type ComposioAccess,
  type ComposioCallbackResult,
  type ComposioKeyStatus,
  type ComposioKeyValidation,
  type ComposioLinkAudience,
  type ComposioLinkRecord,
  type ComposioLinkStart,
  type ComposioLinkStatus,
  type ComposioLinkView,
  type ComposioProvider,
  type ComposioStatusView,
  type ComposioStore,
  type ComposioToolAccess,
  type ComposioToolConnection,
  type WorkspaceComposioConfig,
  type WorkspaceComposioKeyRecord,
} from "./composio.ts";
export { createComposioRoutes, type ComposioRoutesDeps } from "./composio-routes.ts";
export { MemoryComposioStore, PgComposioStore, createPgComposioStore, COMPOSIO_SCHEMA_SQL, type PgComposioOptions } from "./composio-store.ts";
export { httpComposioProvider, type HttpComposioProviderOptions } from "./composio-provider.ts";
export { MemoryPlatformRepository } from "./memory-repository.ts";
export { PgPlatformRepository, createPgPlatformRepository, PLATFORM_SCHEMA_SQL, type PgPlatformOptions } from "./pg-repository.ts";
export { MemoryPlatformAuth, betterAuthAdapter, initPlatformAuth, type BetterAuthOptions, type PlatformAuthInit } from "./auth.ts";
export {
  PlatformError,
  isPlatformError,
  InvitationConflictError,
  type AuthenticatedHuman,
  type BotRuntime,
  type BotTurnRequest,
  type ConnectionRecord,
  type InvitationRecord,
  type MembershipRecord,
  type MessageRecord,
  type PlatformAuth,
  type PlatformConfig,
  type PlatformRepository,
  type PlatformTurnSink,
  type PrincipalRecord,
  type RecoveryKeyRecord,
  type SecretReferenceRecord,
  type StreamEventRecord,
  type WorkspaceRecord,
} from "./contracts.ts";
