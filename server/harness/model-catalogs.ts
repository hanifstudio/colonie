// Announce a background model discovery once its list lands.
import type { ProviderInstance } from "../contracts.ts";

/**
 * Tell the app once for each engine whose model list lands, through `announce`.
 * A discovery that fails is silent, and an announcement that throws does not
 * stop another engine's. Resolves when every discovery has settled.
 */
export function announceWhenModelsLand(instances: readonly ProviderInstance[], announce: () => void): Promise<void> {
  return Promise.all(instances.flatMap((instance) => {
    const discovery = instance.startupModelRefresh;
    if (!discovery) return [];
    return [discovery.then(
      () => { try { announce(); } catch { /* the next engine still gets its turn */ } },
      () => { /* a failed discovery leaves the old catalog */ },
    )];
  })).then(() => undefined);
}
