import type { AppConfig } from '../config.js';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import type { LlmProvider } from './provider.js';

/**
 * Build the configured provider. Defaults to the offline deterministic fake
 * provider; the Hy3 provider is only constructed when the server-side env
 * explicitly selects it (and config validation has already ensured the
 * required variables exist).
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
