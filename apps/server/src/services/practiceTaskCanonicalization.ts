import { projectLearnerPracticeSurface } from '@hy3-clinic/shared';

type PublicSurface = Parameters<typeof projectLearnerPracticeSurface>[0];
type Comparable<T> = { status: 'comparable'; value: T };
type Uncertain = { status: 'uncertain' };
type ContentToken = { kind: 'word' | 'number' | 'symbol' | 'literal' | 'separator'; text: string };

const uncertain: Uncertain = { status: 'uncertain' };
// A combining mark needs a letter base; a mark decomposed from an exact
// operator is not an independent prose atom.
const word = /^(?:\p{Script=Han}|\p{L}[\p{L}\p{M}\p{N}]*(?:['_][\p{L}\p{M}\p{N}]+)*)/u;
const number = /^\p{N}+(?:\.\p{N}+)?(?:[eE][+\-−]?\p{N}+)?/u;
const quotes: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', "'": "'" };
const prose = (tokens: ContentToken[]) =>
  tokens.some(({ kind }) => kind === 'literal') ||
  tokens.filter(({ kind, text }) => kind === 'word' && /\p{L}{2}/u.test(text)).length >= 2 ||
  tokens.filter(({ kind, text }) => kind === 'word' && /\p{Script=Han}/u.test(text)).length >= 2;
const operand = (text: string) =>
  /^(?:\p{N}+(?:\.\p{N}+)?(?:[eE][+\-−]?\p{N}+)?|[A-Za-z])$/u.test(text);
const rightOperand = (text: string) =>
  /^(?:\p{N}+(?:\.\p{N}+)?(?:[eE][+\-−]?\p{N}+)?|[A-Za-z])(?![\p{L}\p{N}_])/u.exec(
    text.trimStart(),
  )?.[0];
const leftOperand = (token: ContentToken | undefined) =>
  token && (operand(token.text) || (token.kind === 'symbol' && /^[)\]}]$/u.test(token.text)));

/** Every comparable atom passes here. Prose accepts canonical Unicode/reflow;
 * exact atoms must already be invariant under both NFC and NFD. Otherwise their
 * character identity is ambiguous and the whole comparison must decline. */
function canonicalTextAtom(
  kind: ContentToken['kind'],
  text: string,
  proseLike = false,
): ContentToken | undefined {
  const nfc = text.normalize('NFC');
  if (!proseLike && (text !== nfc || text !== text.normalize('NFD'))) return undefined;
  if (!proseLike) return { kind, text: nfc };
  const reflowed = nfc.replace(/\s+/gu, ' ').trim();
  return {
    kind,
    text:
      kind === 'literal'
        ? `${reflowed[0]}${reflowed.slice(1, -1).trim()}${reflowed.at(-1)}`
        : reflowed,
  };
}

const proseQuotation = (text: string) => {
  if (!/^[\p{L}\p{M}\s]+$/u.test(text)) return false;
  const words = text.match(/[\p{L}\p{M}]+/gu) ?? [];
  return (
    words.filter((value) => (value.match(/\p{L}/gu)?.length ?? 0) >= 2).length >= 2 ||
    (text.match(/\p{Script=Han}/gu)?.length ?? 0) >= 2
  );
};

/** Comparison-only grammar, never a renderer or a proof-input projection.
 * - Prose words retain case and boundaries; Han characters are individual tokens.
 * - All comparable atoms use one NFC path. Prose supports canonical Unicode and
 *   whitespace/line-ending reflow; exact atoms decline if NFC/NFD can affect them.
 * - Balanced *, **, ***, _, __, ___ may wrap clearly prose spans (two words
 *   containing at least two letters each, or two Han characters) at word
 *   boundaries, nesting at most four levels. Intraword/ambiguous markers decline.
 * - Numbers, identifiers, operators and math grouping survive unchanged.
 * - Quotes support only letter/whitespace prose with two multi-letter words or
 *   two Han characters, without an exact-code/literal context. Other quoted
 *   constructs decline. Supported CJK quotation styles share a delimiter.
 * - Code/HTML/links/block Markdown, ambiguous punctuation/groups/markers and
 *   unsupported syntax decline instead of manufacturing evidence of a change.
 */
function canonicalizeTextTokens(text: string): Comparable<ContentToken[]> | Uncertain {
  // These are unsupported constructs, not characters to delete.
  if (
    /(?:^|\n)[ \t]*(?:#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s|`{3}|~{3})/u.test(text) ||
    /`|~~|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-f]+|[A-Za-z][\w]*);|\[[^\]\n]*\]\s*\(|\\/iu.test(
      text,
    ) ||
    /(?:^|\n)[ \t]*\|[^\n]*\|[ \t]*(?:\n|$)/u.test(text)
  )
    return uncertain;
  // Explicit exact-character contexts cannot establish prose normalization
  // safety, even if an individual quoted value resembles ordinary prose.
  const exactContext =
    /\b(?:code|literal|identifier|bytes?|unicode|characters?|strings?|exact|NFC|NFD|normalization)\b|代码|字面量|标识符|字符|字节|编码/iu.test(
      text,
    );
  let index = 0;
  let grouping = 0;
  const parse = (
    closing?: string,
    depth = 0,
    parentClosing?: string,
  ): ContentToken[] | undefined => {
    const start = index;
    let multiplications = 0;
    const tokens: ContentToken[] = [];
    const emit = (kind: ContentToken['kind'], atom: string, proseLike = false) => {
      const canonical = canonicalTextAtom(kind, atom, proseLike);
      if (!canonical) return false;
      tokens.push(canonical);
      return true;
    };
    while (index < text.length) {
      const rest = text.slice(index);
      const space = /^\s+/u.exec(rest);
      if (space) {
        index += space[0].length;
        continue;
      }
      const marker = /^(?:\*+|_+)/u.exec(rest)?.[0];
      if (marker && marker === closing) {
        const next = text[index + marker.length];
        const parentCloses = parentClosing && text.startsWith(parentClosing, index + marker.length);
        if (
          /\s/u.test(text[index - 1] ?? '') ||
          (!parentCloses && next && /[\p{L}\p{N}_]/u.test(next))
        )
          return undefined;
        index += marker.length;
        return tokens;
      }
      const current = text[index]!;
      const quoteEnd = quotes[current];
      if (quoteEnd) {
        const end = text.indexOf(quoteEnd, index + 1);
        if (end < 0) return undefined;
        const literal = text.slice(index + 1, end);
        if (exactContext || !proseQuotation(literal)) return undefined;
        const cjkQuote = /[“「『]/u.test(current);
        if (!emit('literal', cjkQuote ? `“${literal}”` : text.slice(index, end + 1), true))
          return undefined;
        index = end + 1;
        continue;
      }
      const numeric = number.exec(rest)?.[0];
      if (numeric) {
        if (!emit('number', numeric)) return undefined;
        index += numeric.length;
        continue;
      }
      const lexical = word.exec(rest)?.[0];
      if (lexical) {
        // A joined Latin/Han spelling can be prose layout or one identifier.
        // Splitting it would invent word-boundary evidence, so decline it.
        if (
          (/\p{Script=Han}/u.test(lexical) && /[A-Za-z]/u.test(lexical)) ||
          (/\p{Script=Han}/u.test(text[index - 1] ?? '') && /^[A-Za-z]/u.test(lexical))
        )
          return undefined;
        const proseLike =
          !exactContext &&
          grouping === 0 &&
          /^[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*$/u.test(lexical) &&
          ((lexical.match(/\p{L}/gu)?.length ?? 0) >= 2 || /\p{Script=Han}/u.test(lexical));
        if (!emit('word', lexical, proseLike)) return undefined;
        index += lexical.length;
        continue;
      }
      if (marker) {
        const left = tokens.at(-1);
        const right = rightOperand(rest.slice(marker.length));
        // A single multiplication sign between simple operands is content.
        if (marker === '*' && leftOperand(left) && right) {
          // Two potential delimiters can also spell intraword emphasis, so an
          // unmarked multiplication chain is outside this small grammar.
          if (multiplications++ > 0) return undefined;
          if (!emit('symbol', marker)) return undefined;
          index += 1;
          continue;
        }
        if (
          depth >= 4 ||
          !/^(?:\*{1,3}|_{1,3})$/u.test(marker) ||
          (index !== start && /[\p{L}\p{N}_]/u.test(text[index - 1] ?? '')) ||
          /\s/u.test(text[index + marker.length] ?? '')
        )
          return undefined;
        index += marker.length;
        const inner = parse(marker, depth + 1, closing);
        if (!inner || !prose(inner)) return undefined;
        tokens.push(...inner);
        continue;
      }
      if (/[([{]/u.test(current)) {
        const end = text.slice(index + 1).search(/[)\]}]/u);
        if (end < 0) return undefined;
        const inside = text.slice(index + 1, index + 1 + end);
        // Prose brackets could be decoration or task grouping; do not guess.
        if (/\p{Script=Han}|\p{L}{2}/u.test(inside)) return undefined;
        grouping += 1;
      }
      const operator = /^(?:!=|==|<=|>=|&&|\|\|)/u.exec(rest)?.[0];
      if (operator) {
        const mathematical =
          grouping > 0 || (leftOperand(tokens.at(-1)) && rightOperand(rest.slice(operator.length)));
        if (!emit(mathematical ? 'symbol' : 'separator', operator)) return undefined;
        index += operator.length;
        continue;
      }
      if (/^[.!?。！？]{2}/u.test(rest)) return undefined;
      // Only ASCII mathematical grouping has a supported role. Other paired
      // punctuation could surround prose as decoration or literal data.
      if (/[\p{Ps}\p{Pe}\p{Pi}\p{Pf}]/u.test(current) && !/[()[\]{}]/u.test(current))
        return undefined;
      if (!/[\p{P}\p{Sm}\p{Sc}]|[²³°]/u.test(current)) return undefined;
      // Keep punctuation in the canonical content. A changed prose separator
      // alone is not reliable evidence of a new solving task (see comparison).
      const right = rightOperand(rest.slice(current.length));
      const mathematical =
        grouping > 0 ||
        (/\p{Sm}|[-/%]/u.test(current) && leftOperand(tokens.at(-1)) && right) ||
        (/[+\-−]/u.test(current) && right && number.test(right)) ||
        (current === '%' && tokens.at(-1)?.kind === 'number');
      const separator = !/[()[\]{}]/u.test(current) && !mathematical;
      if (!emit(separator ? 'separator' : 'symbol', current)) return undefined;
      if (/[)\]}]/u.test(current)) grouping = Math.max(0, grouping - 1);
      index += current.length;
    }
    return closing ? undefined : tokens;
  };
  const tokens = parse();
  if (!tokens?.length) return uncertain;
  return { status: 'comparable', value: tokens };
}

/** A stable textual form for comparable content, useful for idempotence checks.
 * Only the typed task representation below participates in change detection. */
export function canonicalizePracticeTaskText(text: string): Comparable<string> | Uncertain {
  const canonical = canonicalizeTextTokens(text);
  if (canonical.status === 'uncertain') return canonical;
  return {
    status: 'comparable',
    value: canonical.value.map(({ text: value }) => value).join(' '),
  };
}

export type CanonicalPracticeTask = { prompt: ContentToken[]; options: ContentToken[][] };

const sortContents = (options: ContentToken[][]) =>
  options.sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });

export function canonicalizeLearnerPracticeTask(
  surface: PublicSurface,
): Comparable<CanonicalPracticeTask> | Uncertain {
  const visible = projectLearnerPracticeSurface(surface);
  const prompt = canonicalizeTextTokens(visible.prompt);
  if (prompt.status === 'uncertain') return uncertain;
  const options: ContentToken[][] = [];
  for (const { text } of visible.options) {
    const option = canonicalizeTextTokens(text);
    if (option.status === 'uncertain') return uncertain;
    options.push(option.value);
  }
  return {
    status: 'comparable',
    value: {
      prompt: prompt.value,
      options: sortContents(options),
    },
  };
}

export function compareLearnerPracticeTasks(
  before: PublicSurface,
  after: PublicSurface,
): 'equal' | 'different' | 'uncertain' {
  const original = canonicalizeLearnerPracticeTask(before);
  const rewritten = canonicalizeLearnerPracticeTask(after);
  if (original.status === 'uncertain' || rewritten.status === 'uncertain') return 'uncertain';
  if (JSON.stringify(original.value) === JSON.stringify(rewritten.value)) return 'equal';
  // This is positive evidence from classified content tokens, not punctuation
  // deletion or semantic equivalence. Retain separators above; if only those
  // changed, their effect on meaning is uncertain and cannot clear a warning.
  const contentEvidence = (task: CanonicalPracticeTask) => ({
    prompt: task.prompt.filter(({ kind }) => kind !== 'separator'),
    options: sortContents(
      task.options.map((option) => option.filter(({ kind }) => kind !== 'separator')),
    ),
  });
  return JSON.stringify(contentEvidence(original.value)) ===
    JSON.stringify(contentEvidence(rewritten.value))
    ? 'uncertain'
    : 'different';
}
