import {
  COURSE_POLICY,
  type CourseKnowledge,
  type CourseLesson,
  type LessonAuthor,
  type CourseLessonContent,
} from '@hy3-clinic/shared';
import type { LessonScope } from '../llm/courseContract.js';
import { sha256, stableId } from '../util/canonical.js';
import { requireValid, unique } from './courseValidation.js';

export function validateLessonDelivery(
  lesson: CourseLesson,
  knowledge: CourseKnowledge[],
  author: LessonAuthor,
): CourseLessonContent['deliveryCheck'] {
  const errors: string[] = [];
  if (!unique(author.segments.map((s) => s.id))) errors.push('段落ID重复');
  const required = knowledge.filter((k) => lesson.knowledgeIds.includes(k.id));
  const anchors: CourseLessonContent['deliveryCheck']['anchors'] = [];
  for (const coverage of author.teachingCoverage) {
    const segment = author.segments.find((s) => s.id === coverage.segmentId);
    if (!required.some((k) => k.id === coverage.knowledgeId)) {
      errors.push('正文绑定外来知识');
      continue;
    }
    if (!segment || segment.kind === 'optional_prompt') {
      errors.push(`知识没有实质教学段落:${coverage.knowledgeId}`);
      continue;
    }
    // Quotation punctuation is a locator annotation, not part of the taught assertion.
    // Only trim final punctuation; never guess words, identities or a different paragraph.
    let quote = coverage.teachingQuote;
    if (!segment.text.includes(quote)) quote = quote.replace(/[。.!?！？;；，,:：]+$/u, '');
    const start = quote ? segment.text.indexOf(quote) : -1;
    if (start < 0 || segment.text.indexOf(quote, start + 1) >= 0) {
      errors.push(`正文quote不存在或定位不唯一:${coverage.knowledgeId}`);
      continue;
    }
    if (
      /^(?:#+\s|将(?:要)?(?:学习|解释|介绍)|我们(?:将|要)|知识点[:：]|目录[:：])/u.test(
        quote.trim(),
      ) ||
      quote.trim() === required.find((k) => k.id === coverage.knowledgeId)?.title
    ) {
      errors.push(`标题或未来承诺不能充当讲解:${coverage.knowledgeId}`);
      continue;
    }
    if (
      coverage.objectiveIds.some(
        (id) =>
          !lesson.objectives.some(
            (o) => o.id === id && o.knowledgeIds.includes(coverage.knowledgeId),
          ),
      )
    )
      errors.push('正文目标引用不匹配');
    anchors.push({
      knowledgeId: coverage.knowledgeId,
      objectiveIds: coverage.objectiveIds,
      segmentId: segment.id,
      start,
      end: start + quote.length,
      segmentHash: sha256(segment.text),
    });
  }
  for (const k of required) {
    if (!anchors.some((a) => a.knowledgeId === k.id)) errors.push(`正文漏讲:${k.id}`);
    for (const objective of lesson.objectives.filter((o) => o.knowledgeIds.includes(k.id)))
      if (!anchors.some((a) => a.knowledgeId === k.id && a.objectiveIds.includes(objective.id)))
        errors.push(`正文漏教学目标:${objective.id}`);
  }
  requireValid([...new Set(errors)]);
  return {
    policyVersion: COURSE_POLICY,
    requiredKnowledgeHash: sha256(required),
    anchors,
    localChecksHash: sha256({ lesson, segments: author.segments, anchors }),
    targetedReceipts: [],
  };
}
function numericExpression(expression: string): number | null {
  const tokens = expression
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .match(/\d+(?:\.\d+)?|[()+\-*/]/gu);
  if (
    !tokens ||
    tokens.join('') !== expression.replace(/\s/gu, '').replaceAll('×', '*').replaceAll('÷', '/')
  )
    return null;
  let cursor = 0;
  const atom = (): number => {
    const token = tokens[cursor++];
    if (token === '(') {
      const n = sum();
      if (tokens[cursor++] !== ')') throw new Error();
      return n;
    }
    if (token === '-') return -atom();
    if (!token || !/^\d/u.test(token)) throw new Error();
    return Number(token);
  };
  const product = (): number => {
    let n = atom();
    while (tokens[cursor] === '*' || tokens[cursor] === '/') {
      const op = tokens[cursor++];
      const next = atom();
      n = op === '*' ? n * next : n / next;
    }
    return n;
  };
  const sum = (): number => {
    let n = product();
    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const op = tokens[cursor++];
      const next = product();
      n = op === '+' ? n + next : n - next;
    }
    return n;
  };
  try {
    const n = sum();
    return cursor === tokens.length && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
export function selectLessonVerificationScopes(
  knowledge: CourseKnowledge[],
  author: LessonAuthor,
  sources: { text: string }[],
  check: CourseLessonContent['deliveryCheck'],
): LessonScope[] {
  const scopes: LessonScope[] = [];
  for (const segment of author.segments) {
    const anchored = check.anchors.filter((a) => a.segmentId === segment.id);
    const ids = [...new Set(anchored.map((a) => a.knowledgeId))];
    const relevant = knowledge.filter((k) => ids.includes(k.id));
    const reasons: string[] = [];
    for (const k of relevant) {
      const quotes = anchored
        .filter((a) => a.knowledgeId === k.id)
        .map((a) => segment.text.slice(a.start, a.end))
        .join(' ');
      const normalize = (s: string) => s.replace(/[\s，。；：、,.!:;（）()]/gu, '');
      const source = normalize(k.statement);
      const taught = normalize(quotes);
      if (!source.includes(taught) && !taught.includes(source)) {
        const grams = (s: string) =>
          new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
        const sg = grams(source),
          tg = grams(taught);
        const overlap =
          [...tg].filter((g) => sg.has(g)).length / Math.max(1, Math.min(sg.size, tg.size));
        if (
          overlap < 0.2 ||
          /不|无|禁止|必须|仅|only|not|must/iu.test(source) !==
            /不|无|禁止|必须|仅|only|not|must/iu.test(taught)
        )
          reasons.push('fact_change_or_suspect_coverage');
      }
    }
    if (segment.uncertaintyCodes.length || relevant.some((k) => k.uncertaintyCodes.length))
      reasons.push('uncertain');
    if (
      ['proof', 'worked_example'].includes(segment.kind) ||
      /证明|推导|proof|therefore/iu.test(segment.text)
    )
      reasons.push('derivation_or_answered_example');
    // Only a complete numeric side can be checked locally. Matching a suffix of
    // 4² or a variable expression invents a different equation and rejects valid math.
    const normalizedMath = segment.text.replaceAll('−', '-');
    const equations = [
      ...normalizedMath.matchAll(
        /(?<![\p{L}\p{N}_.()+\-*/×÷\s])([\d.()+\-*/×÷\s]+)=\s*([\d.()+\-*/×÷\s]+)(?![\d.²³^+\-*/×÷\p{L}\p{N}])/gu,
      ),
    ];
    const values = equations.map((match) => ({
      expression: match[1]!.trim(),
      expected: numericExpression(match[2]!.trim()),
      actual: numericExpression(match[1]!.trim()),
      exactSourceMapping: sources.some((s) => s.text.includes(match[0]!.trim())),
    }));
    requireValid(
      values.some(
        (v) =>
          v.actual !== null &&
          v.expected !== null &&
          Math.abs(v.actual - v.expected) > 1e-9 * Math.max(1, Math.abs(v.expected)),
      )
        ? [`错误算式:${segment.id}`]
        : [],
    );
    const proven =
      values.length > 0 &&
      values.every((v) => v.actual !== null && v.expected !== null && v.exactSourceMapping);
    if (
      (segment.kind === 'calculation' || /计算|[=∑∫]|\d+\s*[×÷*/]/u.test(segment.text)) &&
      !proven
    )
      reasons.push('computation_mapping');
    if (
      relevant.some(
        (k) =>
          ['condition', 'exception', 'procedure'].includes(k.kind) &&
          /如果|仅当|除非|例外|步骤|unless|provided|except/iu.test(k.statement) &&
          !/如果|仅当|除非|例外|步骤|unless|provided|except/iu.test(
            anchored
              .filter((a) => a.knowledgeId === k.id)
              .map((a) => segment.text.slice(a.start, a.end))
              .join(' '),
          ),
      )
    )
      reasons.push('missing_condition_or_step');
    if (
      anchored.length > 1 &&
      new Set(anchored.map((a) => `${a.start}:${a.end}`)).size < new Set(ids).size &&
      relevant.some((k) => !segment.text.includes(k.statement))
    )
      reasons.push('shared_generic_anchor');
    const sourceNumbers = new Set(sources.flatMap((s) => s.text.match(/\d+(?:\.\d+)?/gu) ?? []));
    if (
      segment.origin === 'textbook' &&
      (segment.text.match(/\d+(?:\.\d+)?/gu) ?? []).some((n) => !sourceNumbers.has(n))
    )
      reasons.push('changed_numeric_fact');
    if (reasons.length) {
      const hash = sha256({ segment, relevant, reasons });
      scopes.push({
        id: stableId('scope', hash),
        hash,
        segmentIds: [segment.id],
        knowledgeIds: ids,
        reasons,
      });
    }
  }
  return scopes;
}
