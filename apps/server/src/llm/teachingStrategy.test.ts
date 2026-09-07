import { describe, expect, it, vi } from 'vitest';
import { Hy3Provider } from './hy3Provider.js';
import { teachingStrategyMessages, validateTeachingStrategies } from './teachingStrategy.js';
import type { TeachingStrategyInput } from './provider.js';

const input: TeachingStrategyInput = {
  courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'focused' },
  objectives: [
    {
      objectiveRef: 'O1',
      title: 'Conditional probability',
      description: 'Compute a conditional proportion in a new group.',
    },
  ],
};
describe('teaching representation selection', () => {
  it('reserves computed cases for faithful supported models and preserves Depth/Focus', () => {
    const prompt = teachingStrategyMessages(input)
      .map((m) => m.content)
      .join('\n');
    expect(prompt).toContain('probability/ratios');
    expect(prompt).toContain('Do not invent a count limit');
    expect(prompt).toContain('working_fluency');
    expect(prompt).toContain('focused');
    expect(
      validateTeachingStrategies(
        {
          choices: [
            {
              objectiveRef: 'O1',
              strategy: 'authored',
              rationale: 'Ratios require unsupported division.',
            },
          ],
        },
        input,
      ).valid,
    ).toBe(true);
    expect(
      validateTeachingStrategies(
        {
          choices: [
            {
              objectiveRef: 'foreign',
              strategy: 'computed',
              rationale: 'Use a different goal instead.',
            },
          ],
        },
        input,
      ).valid,
    ).toBe(false);
    expect(validateTeachingStrategies({ choices: [] }, input).valid).toBe(false);
  });
  it('uses a bounded real provider interface with exact choice validation', async () => {
    const result = {
      choices: [
        {
          objectiveRef: 'O1',
          strategy: 'authored',
          rationale: 'A conditional proportion needs division, not a boolean proxy.',
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
        ),
    );
    const provider = new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 30000,
      fetchImpl,
    });
    expect(await provider.planTeachingStrategies(input)).toEqual(result);
    const request = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as { max_tokens: number };
    expect(request.max_tokens).toBe(4000);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
