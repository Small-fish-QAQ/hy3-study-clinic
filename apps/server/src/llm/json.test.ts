import { describe, expect, it } from 'vitest';
import { extractJson, JsonExtractionError } from './json.js';

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a markdown fence', () => {
    expect(extractJson('说明如下\n```json\n{"a": [1,2]}\n```\n完毕')).toEqual({ a: [1, 2] });
  });

  it('parses the first balanced object embedded in prose', () => {
    expect(extractJson('好的,这是结果:{"name":"工作记忆","n":4},请查收。')).toEqual({
      name: '工作记忆',
      n: 4,
    });
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

  it('rejects absurdly long input', () => {
    expect(() => extractJson('x'.repeat(1_000_001))).toThrowError(JsonExtractionError);
  });
});
