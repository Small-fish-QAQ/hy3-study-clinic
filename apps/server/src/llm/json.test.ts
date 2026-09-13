import { describe, expect, it } from 'vitest';
import { extractJson, JsonExtractionError } from './json.js';

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON when one markdown fence is the complete response', () => {
    expect(extractJson('```json\n{"a": [1,2]}\n```')).toEqual({ a: [1, 2] });
  });

  it('rejects prose around JSON instead of fishing for a balanced fragment', () => {
    expect(() => extractJson('好的,这是结果:{"name":"工作记忆","n":4},请查收。')).toThrowError(
      JsonExtractionError,
    );
    expect(() => extractJson('说明如下\n```json\n{"a": [1,2]}\n```\n完毕')).toThrowError(
      JsonExtractionError,
    );
  });

  it('handles braces inside JSON strings', () => {
    expect(extractJson('{"text":"包含 } 与 { 的字符串"}')).toEqual({
      text: '包含 } 与 { 的字符串',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"text":"他说:\\"你好\\""}')).toEqual({ text: '他说:"你好"' });
  });

  it('throws when no JSON is present', () => {
    expect(() => extractJson('抱歉,我无法完成该任务。')).toThrowError(JsonExtractionError);
  });

  it('throws on unbalanced JSON', () => {
    expect(() => extractJson('{"a": [1, 2')).toThrowError(JsonExtractionError);
  });

  it.each([
    '{"slots":[{"nested":{"value":1},{"slotId":"L2"}]}',
    '{"a":[1,2}}',
    '```json\n{"a":[1,2}}\n```',
  ])('classifies mismatched containers as malformed, not an incomplete prefix: %s', (raw) => {
    expect(() => extractJson(raw)).toThrowError(expect.objectContaining({ kind: 'invalid_json' }));
  });

  it.each(['{"slots":[{"nested":{"value":1}', '{"text":"unfinished'])(
    'preserves clean output recovery for an actually unfinished prefix: %s',
    (raw) => {
      expect(() => extractJson(raw)).toThrowError(
        expect.objectContaining({ kind: 'incomplete_json' }),
      );
    },
  );

  it('leaves a wrong top-level wrapper intact for schema rejection', () => {
    expect(extractJson('{"data":{"a":1}}')).toEqual({ data: { a: 1 } });
  });

  it('rejects absurdly long input', () => {
    expect(() => extractJson('x'.repeat(1_000_001))).toThrowError(JsonExtractionError);
  });
});
