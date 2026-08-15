import type { AppConfig } from '../config.js';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import type { LlmProvider } from './provider.js';

/**
 * Build one validated provider instance. Runtime Settings overrides are
 * resolved by ProviderRuntime before this factory is called; incomplete Hy3
 * startup configuration therefore remains on the Fake fallback path.
 */
export function createProvider(config: AppConfig): LlmProvider {
  if (config.provider === 'hy3') {
    return new Hy3Provider({
      baseUrl: config.hy3BaseUrl!,
      apiKey: config.hy3ApiKey!,
      model: config.hy3Model!,
      timeoutMs: config.hy3TimeoutMs,
    });
  }
  // Small simulated latency so loading/cancel states are observable in the UI.
  return new FakeProvider({ delayMs: 500 });
}
