import type { AppConfig } from '../config.js';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import type { LlmProvider } from './provider.js';
import type { VisualDescriptionProvider } from './provider.js';
import { TokenHubVisionProvider } from './tokenHubVisionProvider.js';
import { ProviderError } from './errors.js';

class DisabledVisualProvider implements VisualDescriptionProvider {
  readonly name = 'disabled' as const;
  readonly endpointIdentity = 'local:disabled';
  readonly runtimeIdentity = 'visual-provider-disabled-v1';
  readonly promptIdentity = 'visual-provider-disabled-v1';
  async describeVisual(): Promise<never> {
    throw ProviderError.invalidOutput(
      'Visual description provider is not configured.',
      undefined,
      'PROVIDER_FORMAT_INCOMPATIBILITY',
    );
  }
}

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

export function createVisualProvider(config: AppConfig): VisualDescriptionProvider {
  if (config.visualProvider === 'tokenhub') {
    return new TokenHubVisionProvider({
      baseUrl: config.tokenHubVisualBaseUrl!,
      apiKey: config.tokenHubVisualApiKey!,
      model: config.tokenHubVisualModel,
      timeoutMs: config.tokenHubVisualTimeoutMs,
    });
  }
  if (config.visualProvider === 'fake') return new FakeProvider({ delayMs: 500 });
  return new DisabledVisualProvider();
}
