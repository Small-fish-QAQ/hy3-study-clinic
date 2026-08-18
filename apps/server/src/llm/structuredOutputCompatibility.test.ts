import { describe, expect, it, vi } from 'vitest';
import type { SourceBlock } from '@hy3-clinic/shared';
import { z } from 'zod';
import { Hy3Provider } from './hy3Provider.js';
import type { StructuredOutputDiagnostic } from './provider.js';
import { buildStructuredOutputDiagnostic } from './structuredOutputDiagnostics.js';

const PRIVATE_SOURCE = 'PRIVATE_SOURCE_SCALAR_WORKING_MEMORY';
const PRIVATE_MODEL_TEXT = 'PRIVATE_MODEL_SCALAR_SUMMARY';
const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: 'Memory',
    headingPath: ['Memory'],
    content: PRIVATE_SOURCE,
    startOffset: 0,
    endOffset: PRIVATE_SOURCE.length,
  },
];

const validPayload = {
  concepts: [
    {
      name: 'Working memory',
      summary: PRIVATE_MODEL_TEXT,
      importance: 'high',
      blockId: 'blk_0',
      quote: PRIVATE_SOURCE,
    },
  ],
};

function response(content: unknown, finishReason: unknown = 'stop'): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function providerFor(
  contents: unknown[],
  finishReasons: unknown[] = [],
): {
  provider: Hy3Provider;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const fetchImpl = vi.fn(async () => {
    const current = index++;
    return response(contents[current] ?? contents.at(-1), finishReasons[current] ?? 'stop');
  });
  return {
    provider: new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'PRIVATE_CREDENTIAL',
      model: 'hy3-test',
      timeoutMs: 30_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    fetchImpl,
  };
}

async function run(
  contents: unknown[],
  options: {
    finishReasons?: unknown[];
    validateCandidate?: () => {
      valid: boolean;
      diagnostics: string[];
      diagnosticCodes?: string[];
    };
  } = {},
) {
  const { provider, fetchImpl } = providerFor(contents, options.finishReasons);
  const diagnostics: StructuredOutputDiagnostic[] = [];
  const promise = provider.analyzeConcepts(
    { materialTitle: 'PRIVATE_MATERIAL_TITLE', blocks },
    {
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      ...(options.validateCandidate ? { validateCandidate: options.validateCandidate } : {}),
      telemetry: {
        workspaceId: 'ws_1',
        operationType: 'curriculum_course_map',
        schemaFingerprint: 'course-map-proposal-v1',
      },
    },
  );
  return { promise, diagnostics, fetchImpl };
}

describe('Hy3 structured-output compatibility diagnostics', () => {
  it.each([
    ['direct JSON', JSON.stringify(validPayload), 'direct'],
    [
      'one complete markdown fence',
      `\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``,
      'markdown_json_fence',
    ],
  ] as const)('accepts known-safe %s', async (_label, content, format) => {
    const execution = await run([content]);
    await expect(execution.promise).resolves.toEqual(validPayload);
    expect(execution.fetchImpl).toHaveBeenCalledTimes(1);
    expect(execution.diagnostics).toMatchObject([
      {
        schemaName: 'course-map-proposal-v1',
        attemptNumber: 1,
        jsonParseSuccess: true,
        jsonFormat: format,
        failureCategory: null,
        repairAction: 'none',
      },
    ]);
  });

  it.each([
    ['empty content', '', 'EMPTY_RESPONSE'],
    [
      'prose plus JSON',
      `Result: ${JSON.stringify(validPayload)}`,
      'PROVIDER_FORMAT_INCOMPATIBILITY',
    ],
    ['wrong wrapper', JSON.stringify({ data: validPayload }), 'SCHEMA_VALIDATION_FAILURE'],
    [
      'null instead of required array',
      JSON.stringify({ concepts: null }),
      'SCHEMA_VALIDATION_FAILURE',
    ],
    [
      'wrong enum',
      JSON.stringify({ concepts: [{ ...validPayload.concepts[0], importance: 'critical' }] }),
      'SCHEMA_VALIDATION_FAILURE',
    ],
    ['malformed JSON', '{"concepts":}', 'JSON_PARSE_FAILURE'],
    ['incomplete JSON without a provider truncation signal', '{"concepts":[', 'JSON_PARSE_FAILURE'],
  ] as const)('rejects %s after exactly one repair', async (_label, content, category) => {
    const execution = await run([content, content]);
    await expect(execution.promise).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: `REPAIR_EXHAUSTED:${category}`,
    });
    expect(execution.fetchImpl).toHaveBeenCalledTimes(2);
    expect(execution.diagnostics.map((item) => item.failureCategory)).toEqual([category, category]);
    expect(execution.diagnostics.map((item) => item.repairAction)).toEqual([
      'requested',
      'exhausted',
    ]);
  });

  it('treats finish_reason=length as truncation even when the partial value parses', async () => {
    const content = JSON.stringify(validPayload);
    const execution = await run([content, content], { finishReasons: ['length', 'length'] });
    await expect(execution.promise).rejects.toMatchObject({
      technicalFailureCode: 'REPAIR_EXHAUSTED:TRUNCATED_OUTPUT',
    });
    expect(execution.diagnostics).toMatchObject([
      { finishReason: 'length', truncated: true, failureCategory: 'TRUNCATED_OUTPUT' },
      { finishReason: 'length', truncated: true, failureCategory: 'TRUNCATED_OUTPUT' },
    ]);
  });

  it.each(['sensitive', 'content_filter', 'tool_calls', 'function_call'] as const)(
    'fails closed without repair when finish_reason=%s',
    async (finishReason) => {
      const content = JSON.stringify(validPayload);
      const execution = await run([content], { finishReasons: [finishReason] });
      await expect(execution.promise).rejects.toMatchObject({
        technicalFailureCode: 'PROVIDER_FORMAT_INCOMPATIBILITY',
      });
      expect(execution.fetchImpl).toHaveBeenCalledTimes(1);
      expect(execution.diagnostics).toMatchObject([
        {
          finishReason,
          jsonParseSuccess: true,
          failureCategory: 'PROVIDER_FORMAT_INCOMPATIBILITY',
          repairAction: 'none',
        },
      ]);
    },
  );

  it('classifies schema-valid semantic failures and keeps stable issue codes', async () => {
    const content = JSON.stringify(validPayload);
    const execution = await run([content, content], {
      validateCandidate: () => ({
        valid: false,
        diagnostics: ['PRIVATE_CANDIDATE_DETAIL'],
        diagnosticCodes: ['unknown_source_region'],
      }),
    });
    await expect(execution.promise).rejects.toMatchObject({
      technicalFailureCode: 'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
    });
    expect(execution.diagnostics[0]).toMatchObject({
      semanticIssueCodes: ['unknown_source_region'],
      failureCategory: 'SEMANTIC_VALIDATION_FAILURE',
    });
  });

  it('redacts every scalar and bounds structural previews without retaining raw content', async () => {
    const content = JSON.stringify(validPayload);
    const execution = await run([content]);
    await execution.promise;

    const serialized = JSON.stringify(execution.diagnostics);
    expect(serialized).not.toContain(PRIVATE_SOURCE);
    expect(serialized).not.toContain(PRIVATE_MODEL_TEXT);
    expect(serialized).not.toContain('PRIVATE_MATERIAL_TITLE');
    expect(serialized).not.toContain('PRIVATE_CREDENTIAL');
    expect(serialized).not.toContain(content);
    expect(serialized).toContain('<string>');
    expect(serialized.length).toBeLessThan(10_000);
    expect(execution.diagnostics[0]).toMatchObject({
      contentType: 'string',
      contentBytes: Buffer.byteLength(content, 'utf8'),
      contentFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      topLevelKeys: ['concepts'],
      structuralPreview: {
        concepts: { $type: 'array', $length: 1 },
      },
    });
  });

  it('hashes unknown object keys, schema paths, and semantic codes', async () => {
    const privateKey = 'PRIVATE_SOURCE_TEXT_AS_KEY';
    const privateCode = 'PRIVATE_SOURCE_TEXT_AS_CODE';
    const content = JSON.stringify({
      concepts: [{ ...validPayload.concepts[0], [privateKey]: true }],
    });
    const execution = await run([content, content], {
      validateCandidate: () => ({
        valid: false,
        diagnostics: ['PRIVATE_CANDIDATE_DETAIL'],
        diagnosticCodes: [privateCode],
      }),
    });
    await expect(execution.promise).rejects.toMatchObject({
      technicalFailureCode: 'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
    });

    const serialized = JSON.stringify(execution.diagnostics);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain(privateCode);
    expect(serialized).toMatch(/<key:sha256:[0-9a-f]{64}>/u);
    expect(serialized).toMatch(/<code:sha256:[0-9a-f]{64}>/u);

    const recordResult = z.record(z.string()).safeParse({ [privateKey]: 42 });
    expect(recordResult.success).toBe(false);
    if (recordResult.success) throw new Error('Expected the record fixture to fail.');
    const pathDiagnostic = buildStructuredOutputDiagnostic({
      schemaName: 'private-path-fixture',
      operationType: null,
      attemptNumber: 1,
      attemptKind: 'original',
      model: 'hy3-test',
      response: {
        transportSuccess: true,
        httpStatus: 200,
        responseBodyBytes: 1,
        contentType: 'string',
        contentBytes: 1,
        contentFingerprint: null,
        finishReason: 'stop',
        truncated: false,
        possiblyIncomplete: false,
      },
      parse: {
        jsonParseSuccess: true,
        jsonFormat: 'direct',
        parsed: { [privateKey]: 42 },
        schemaIssues: recordResult.error.issues,
        failureCategory: 'SCHEMA_VALIDATION_FAILURE',
      },
      repairAction: 'requested',
    });
    const serializedPathDiagnostic = JSON.stringify(pathDiagnostic);
    expect(serializedPathDiagnostic).not.toContain(privateKey);
    expect(pathDiagnostic.schemaIssues[0]?.path).toMatch(/^<key:sha256:[0-9a-f]{64}>$/u);
  });

  it('caps preview keys, array items, and nesting depth', async () => {
    const oversizedShape = {
      modules: {
        nodes: { modules: { regions: { title: PRIVATE_MODEL_TEXT } } },
        regions: Array.from({ length: 20 }, (_, index) => ({ index })),
        ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key_${index}`, index])),
      },
    };
    const content = JSON.stringify(oversizedShape);
    const execution = await run([content, content]);
    await expect(execution.promise).rejects.toMatchObject({
      technicalFailureCode: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
    });
    const preview = execution.diagnostics[0]!.structuralPreview as {
      modules: Record<string, unknown>;
    };
    expect(preview.modules.$omittedKeys).toBeGreaterThan(0);
    expect(Object.keys(preview.modules).length).toBeLessThanOrEqual(13);
    expect(preview.modules.regions).toMatchObject({ $type: 'array', $length: 20 });
    expect((preview.modules.regions as { $items: unknown[] }).$items).toHaveLength(3);
    expect(preview.modules.nodes).toEqual({ modules: { regions: '<object>' } });
    expect(JSON.stringify(preview)).not.toContain(PRIVATE_MODEL_TEXT);
  });

  it('rejects a provider content envelope with a non-string shape without blind repair', async () => {
    const execution = await run([[{ type: 'text', text: JSON.stringify(validPayload) }]]);
    await expect(execution.promise).rejects.toMatchObject({
      technicalFailureCode: 'PROVIDER_FORMAT_INCOMPATIBILITY',
    });
    expect(execution.fetchImpl).toHaveBeenCalledTimes(1);
    expect(execution.diagnostics).toMatchObject([
      {
        transportSuccess: true,
        contentType: 'array',
        failureCategory: 'PROVIDER_FORMAT_INCOMPATIBILITY',
        repairAction: 'none',
      },
    ]);
  });
});
