/** Safe JSON parsing for direct output or one whole-response markdown fence. */

const MAX_TEXT_LENGTH = 1_000_000;

export class JsonExtractionError extends Error {
  constructor(
    message: string,
    readonly kind:
      'empty' | 'too_long' | 'format_incompatible' | 'invalid_json' | 'incomplete_json',
  ) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

export interface ExtractedJson {
  value: unknown;
  format: 'direct' | 'markdown_json_fence';
}

function appearsIncompleteJson(text: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) === expected) stack.pop();
    }
  }
  return inString || stack.length > 0;
}

function parseCandidate(candidate: string, format: ExtractedJson['format']): ExtractedJson {
  try {
    return { value: JSON.parse(candidate) as unknown, format };
  } catch (error) {
    const kind = appearsIncompleteJson(candidate) ? 'incomplete_json' : 'invalid_json';
    throw new JsonExtractionError(
      `JSON 解析失败:${error instanceof Error ? error.message : String(error)}`,
      kind,
    );
  }
}

/**
 * Parse a complete JSON value. A single whole-response ```json fence is the
 * only accepted compatibility wrapper; prose and embedded-fragment fishing
 * remain rejected.
 */
export function extractJsonWithFormat(text: string): ExtractedJson {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new JsonExtractionError('模型输出过长,拒绝解析。', 'too_long');
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new JsonExtractionError('模型输出为空。', 'empty');
  }

  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    const lastNewline = trimmed.lastIndexOf('\n');
    if (
      firstNewline <= 0 ||
      lastNewline <= firstNewline ||
      trimmed.slice(lastNewline + 1) !== '```'
    ) {
      throw new JsonExtractionError('Markdown JSON 围栏不完整。', 'incomplete_json');
    }
    const opening = trimmed.slice(0, firstNewline).trim().toLowerCase();
    if (opening !== '```json' && opening !== '```') {
      throw new JsonExtractionError('仅支持完整的 JSON Markdown 围栏。', 'format_incompatible');
    }
    return parseCandidate(
      trimmed.slice(firstNewline + 1, lastNewline).trim(),
      'markdown_json_fence',
    );
  }

  try {
    return { value: JSON.parse(trimmed) as unknown, format: 'direct' };
  } catch (error) {
    const beginsAsJson = ['{', '[', '"'].some((prefix) => trimmed.startsWith(prefix));
    if (!beginsAsJson) {
      throw new JsonExtractionError(
        '模型输出包含 JSON 之外的文本,拒绝提取嵌入片段。',
        'format_incompatible',
      );
    }
    const kind = appearsIncompleteJson(trimmed) ? 'incomplete_json' : 'invalid_json';
    throw new JsonExtractionError(
      `JSON 解析失败:${error instanceof Error ? error.message : String(error)}`,
      kind,
    );
  }
}

export function extractJson(text: string): unknown {
  return extractJsonWithFormat(text).value;
}
