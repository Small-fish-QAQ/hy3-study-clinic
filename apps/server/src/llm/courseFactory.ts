import type { AppConfig } from '../config.js';
import type { CourseProvider } from './courseContract.js';
import { CourseFakeProvider } from './courseFakeProvider.js';
import { HttpCourseProvider } from './courseProvider.js';

export function createProvider(config: AppConfig): CourseProvider {
  if (config.provider === 'fake') return new CourseFakeProvider();
  return new HttpCourseProvider({
    provider: config.provider,
    baseUrl: config.hy3BaseUrl ?? '',
    apiKey: config.hy3ApiKey ?? '',
    model: config.hy3Model ?? '',
    timeoutMs: config.hy3TimeoutMs,
    longTaskTimeoutMs: config.longTaskTimeoutMs,
    maxOutputTokens: config.modelMaxOutputTokens,
    contextTokens: config.modelContextTokens,
    reasoningEstimate: config.modelReasoningEstimate,
    reasoningEffort: config.modelReasoningEffort,
  });
}
