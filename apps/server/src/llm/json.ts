/**
 * Safe JSON extraction from model text output.
 *
 * Models frequently wrap JSON in markdown fences or add prose around it.
 * This module extracts the first balanced JSON object/array without ever
 * executing content, and with a hard input-size guard.
 */

const MAX_TEXT_LENGTH = 1_000_000;

export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

/** Extract and parse the first JSON value found in free-form model text. */
export function extractJson(text: string): unknown {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new JsonExtractionError('模型输出过长,拒绝解析。');
  }

  // 1. Prefer fenced ```json blocks.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) {
    const candidate = fence[1].trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to balanced scan
    }
  }

  // 2. Whole-string parse.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  // 3. Balanced scan for the first object/array, string-aware.
  const start = findFirst(text, ['{', '[']);
  if (start === -1) {
    throw new JsonExtractionError('模型输出中未找到 JSON 数据。');
  }
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (err) {
          throw new JsonExtractionError(
            `JSON 解析失败:${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  throw new JsonExtractionError('JSON 数据不完整(括号未闭合)。');
}

function findFirst(text: string, chars: string[]): number {
  let best = -1;
  for (const ch of chars) {
    const idx = text.indexOf(ch);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}
