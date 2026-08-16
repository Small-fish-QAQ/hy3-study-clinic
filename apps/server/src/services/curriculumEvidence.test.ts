import { describe, expect, it } from 'vitest';
import type { ExecutionSourceManifest, SourceBlock } from '@hy3-clinic/shared';
import { verifyGrounding } from '../grounding/verify.js';
import {
  buildCurriculumEvidenceCatalog,
  CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS,
} from './curriculumEvidence.js';

const block: SourceBlock = {
  id: 'blk_revision_a',
  materialId: 'mat_a',
  materialRevisionId: 'rev_a',
  index: 0,
  heading: 'Memory',
  headingPath: ['Memory'],
  pageNumber: 2,
  pageEnd: 2,
  content: 'Working memory is limited. It temporarily holds information for active reasoning.',
  startOffset: 0,
  endOffset: 83,
};
const preferredQuote = 'Working memory is limited.';

const manifest: ExecutionSourceManifest = {
  fingerprint: 'manifest_a',
  revisions: [
    {
      materialId: 'mat_a',
      materialRevisionId: 'rev_a',
      parserVersion: 'parser-1',
      parserFingerprint: 'parser-fingerprint-a',
      sourceBlockRevisionIds: [block.id],
    },
  ],
};

describe('Curriculum evidence catalog', () => {
  it('offers stable bounded exact excerpts and retains preferred authority text', () => {
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [
        {
          blockId: block.id,
          quote: preferredQuote,
          startOffset: 0,
          endOffset: preferredQuote.length,
          occurrenceCount: 1,
          reanchored: false,
        },
      ],
    });
    expect(catalog.length).toBeGreaterThan(1);
    expect(
      catalog.every((offer) => offer.quote.length <= CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS),
    ).toBe(true);
    const selected = catalog.find((offer) => offer.quote === preferredQuote);
    expect(selected).toMatchObject({
      materialId: 'mat_a',
      materialRevisionId: 'rev_a',
      blockId: block.id,
      startOffset: 0,
      endOffset: preferredQuote.length,
    });
    expect(
      verifyGrounding([block], { blockId: selected!.blockId, quote: selected!.quote }).ok,
    ).toBe(true);
    expect(
      buildCurriculumEvidenceCatalog({
        workspaceId: 'ws_a',
        manifest,
        blocks: [block],
        preferredGroundings: [],
      }),
    ).toEqual(
      buildCurriculumEvidenceCatalog({
        workspaceId: 'ws_a',
        manifest,
        blocks: [block],
        preferredGroundings: [],
      }),
    );
  });

  it('does not offer a block outside the exact manifest', () => {
    const foreign: SourceBlock = { ...block, id: 'blk_foreign', materialId: 'mat_foreign' };
    expect(
      buildCurriculumEvidenceCatalog({
        workspaceId: 'ws_a',
        manifest,
        blocks: [block, foreign],
        preferredGroundings: [],
      }).every((offer) => offer.blockId !== foreign.id),
    ).toBe(true);
  });

  it('binds identities to the exact workspace and revision snapshot', () => {
    const original = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [],
    });
    const otherWorkspace = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_b',
      manifest,
      blocks: [block],
      preferredGroundings: [],
    });
    const otherRevisionBlock = { ...block, materialRevisionId: 'rev_b' };
    const otherRevision = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest: {
        ...manifest,
        revisions: [{ ...manifest.revisions[0]!, materialRevisionId: 'rev_b' }],
      },
      blocks: [otherRevisionBlock],
      preferredGroundings: [],
    });
    expect(otherWorkspace.map((offer) => offer.id)).not.toEqual(original.map((offer) => offer.id));
    expect(otherRevision.map((offer) => offer.id)).not.toEqual(original.map((offer) => offer.id));
  });

  it('does not promote a paraphrase supplied as a preferred grounding', () => {
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [
        {
          blockId: block.id,
          quote: 'Working memory has a small capacity.',
          startOffset: 0,
          endOffset: 37,
          occurrenceCount: 1,
          reanchored: false,
        },
      ],
    });
    expect(catalog.some((offer) => offer.quote === 'Working memory has a small capacity.')).toBe(
      false,
    );
  });
});
