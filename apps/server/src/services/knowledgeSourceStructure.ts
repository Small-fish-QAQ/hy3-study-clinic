import type { CourseKnowledgeInventory } from '@hy3-clinic/shared';
import type { SourcePacketBlock } from '../llm/courseContract.js';

/** Resolve explicit numbered proof dependencies as supporting source context.
 * This does not change knowledge ownership, teaching coverage, or accepted source spans.
 */
export function proofSourceContext(selected: SourcePacketBlock[], blocks: SourcePacketBlock[]) {
  const chosen = new Set(selected.map((b) => b.id));
  const same = (a: SourcePacketBlock, b: SourcePacketBlock) =>
    a.revisionId === b.revisionId &&
    JSON.stringify(a.headingPath) === JSON.stringify(b.headingPath);
  const lines = (b: SourcePacketBlock) =>
    b.text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < blocks.length - 2; i++) {
    const header = blocks[i]!,
      separator = blocks[i + 1]!;
    if (
      !lines(header).some((s) => /^\|\s*步骤\s*\|/u.test(s)) ||
      !same(header, separator) ||
      !lines(separator).some((s) => /^\|(?:\s*:?-{3,}:?\s*\|)+$/u.test(s))
    )
      continue;
    const steps = new Map<string, { block: SourcePacketBlock; references: string[] }>();
    for (let j = i + 2; j < blocks.length; j++) {
      const block = blocks[j]!;
      if (!same(header, block)) break;
      // The importer assigns following headings to the preceding citation span.
      // A trailing heading is navigation, not an extra proof row.
      const rows = lines(block).filter((s) => !/^#+\s/u.test(s));
      if (!rows.every((s) => /^\|\s*\d+\s*\|/u.test(s))) break;
      for (const row of rows) {
        const cells = row.split('|');
        const step = cells[1]!.trim();
        const reason = cells.slice(3).join('|');
        const references = [...reason.matchAll(/\(\s*(\d+)\s*\)/gu)].map((m) => m[1]!);
        steps.set(step, { block, references });
      }
    }
    if (![...steps.values()].some((s) => chosen.has(s.block.id))) continue;
    chosen.add(header.id);
    chosen.add(separator.id);
    for (;;) {
      const before = chosen.size;
      for (const step of steps.values()) {
        if (!chosen.has(step.block.id)) continue;
        for (const ref of step.references) {
          const prior = steps.get(ref);
          if (prior) chosen.add(prior.block.id);
        }
      }
      if (chosen.size === before) break;
    }
  }
  return chosen.size === selected.length ? selected : blocks.filter((b) => chosen.has(b.id));
}
/** A table's column header is supporting context for its cited data, not another proposition. */
export function attachTableSourceContext<
  T extends Pick<CourseKnowledgeInventory, 'knowledge' | 'dispositions'>,
>(packet: T, blocks: SourcePacketBlock[]): T {
  const value = structuredClone(packet);
  const lines = (block: SourcePacketBlock) =>
    block.text
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const row = (text: string) => /^\|.*\|$/u.test(text);
  const delimiter = (text: string) => /^\|(?:\s*:?-{3,}:?\s*\|)+$/u.test(text);
  const same = (a: SourcePacketBlock, b: SourcePacketBlock) =>
    a.revisionId === b.revisionId &&
    JSON.stringify(a.headingPath) === JSON.stringify(b.headingPath);
  for (let i = 0; i < blocks.length - 2; i++) {
    const header = blocks[i]!,
      separator = blocks[i + 1]!;
    if (
      !same(header, separator) ||
      lines(header).length !== 1 ||
      !row(lines(header)[0]!) ||
      lines(separator).length !== 1 ||
      !delimiter(lines(separator)[0]!)
    )
      continue;
    const data: SourcePacketBlock[] = [];
    for (let j = i + 2; j < blocks.length; j++) {
      const next = blocks[j]!;
      if (!same(header, next) || !lines(next).every(row) || lines(next).some(delimiter)) break;
      // A new header immediately followed by its delimiter belongs to the next table.
      if (blocks[j + 1] && same(next, blocks[j + 1]!) && lines(blocks[j + 1]!).some(delimiter))
        break;
      data.push(next);
    }
    if (!data.length) continue;
    const owners = value.knowledge.filter(
      (k) =>
        k.origin === 'textbook' && k.sourceSpans.some((s) => data.some((b) => b.id === s.blockId)),
    );
    for (const owner of owners)
      for (const context of [header, separator]) {
        if (!owner.sourceSpans.some((s) => s.blockId === context.id))
          owner.sourceSpans.push({
            revisionId: context.revisionId,
            blockId: context.id,
            start: context.start,
            end: context.end,
          });
        for (const disposition of value.dispositions.filter(
          (d) => d.span.blockId === context.id && d.exclusion === null,
        ))
          if (!disposition.knowledgeIds.includes(owner.id)) disposition.knowledgeIds.push(owner.id);
      }
  }
  return value;
}
