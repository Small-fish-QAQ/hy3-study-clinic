import {
  AcceptAlignmentRequestSchema,
  ApiErrorCode,
  guessConceptLanguage,
  MERGING_ALIGNMENT_RELATIONS,
  normalizeConceptKey,
  RenameCanonicalConceptRequestSchema,
  type AlignmentProposal,
  type CanonicalConcept,
  type CanonicalConceptView,
  type Concept,
  type VerifiedGrounding,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import {
  generateAlignmentCandidates,
  keyPair,
  pairKey,
  type LocalCandidate,
} from '../alignment/candidates.js';
import type { AlignmentCandidate, LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface AlignmentServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

export interface AlignmentOverview {
  canonical: CanonicalConceptView[];
  pendingProposals: AlignmentProposal[];
  decidedProposals: AlignmentProposal[];
}

export interface AlignmentProposalRunResult {
  autoAccepted: AlignmentProposal[];
  created: AlignmentProposal[];
  /** Provider proposals rejected by local validation, with reasons. */
  rejected: Array<{
    sourceConceptId: string | null;
    targetConceptId: string | null;
    reason: string;
  }>;
  candidateCount: number;
}

/**
 * Canonical cross-document concept alignment.
 *
 * Local deterministic code owns: candidate generation and pruning, the ONLY
 * auto-accept rule (exact normalized keys), evidence verification, workspace
 * isolation, merge execution (union of disjoint canonical groups — cycles
 * impossible by construction), and every accept/reject/keep-separate
 * decision. Hy3 only proposes relations between locally-offered candidate
 * pairs. Original source concepts and their learning history are never
 * modified — alignment is a pure additional layer.
 */
export function createAlignmentService({ repos, provider, clock }: AlignmentServiceDeps) {
  function requireWorkspace(workspaceId: string) {
    const workspace = repos.workspaces.get(workspaceId);
    if (!workspace) throw notFound(`课程空间不存在:${workspaceId}`);
    return workspace;
  }

  function ensureBaseline(workspaceId: string): Concept[] {
    const concepts = repos.materials.getConceptsByWorkspace(workspaceId);
    repos.alignment.ensureBaseline(workspaceId, concepts, clock.now().toISOString());
    return concepts;
  }

  function conceptTitleMap(workspaceId: string): Map<string, string> {
    return new Map(repos.materials.listByWorkspace(workspaceId).map((m) => [m.id, m.title]));
  }

  /**
   * Deterministic display-name choice for auto-accepted alias pairs:
   * Chinese beats Latin, a spaced multi-word name beats a concatenated one
   * ("Spaced repetition" over "Spacedrepetition"), then the shorter name
   * wins with a lexicographic tie-break.
   */
  function preferredDisplayName(a: string, b: string): string {
    const aCjk = /[一-鿿]/u.test(a);
    const bCjk = /[一-鿿]/u.test(b);
    if (aCjk !== bCjk) return aCjk ? a : b;
    const aSpaced = a.includes(' ');
    const bSpaced = b.includes(' ');
    if (aSpaced !== bSpaced) return aSpaced ? a : b;
    if (a.length !== b.length) return a.length < b.length ? a : b;
    return a < b ? a : b;
  }

  /** Persist one accepted local-rule alias proposal and merge immediately. */
  function autoAcceptCandidate(
    workspaceId: string,
    candidate: LocalCandidate,
    at: string,
  ): AlignmentProposal {
    const displayName = preferredDisplayName(candidate.source.name, candidate.target.name);
    const proposal: AlignmentProposal = {
      id: newId('alp'),
      workspaceId,
      sourceConceptId: candidate.source.id,
      targetConceptId: candidate.target.id,
      relation: 'alias',
      proposedCanonicalName: displayName,
      rationale: '本地规则:两个概念名称在 Unicode/大小写/空白/标点规范化后完全一致。',
      evidence: [candidate.source.grounding, candidate.target.grounding],
      origin: 'local_rule',
      status: 'accepted',
      sourceLanguage: guessConceptLanguage(candidate.source.name),
      targetLanguage: guessConceptLanguage(candidate.target.name),
      provider: 'local',
      createdAt: at,
      decidedAt: at,
    };
    repos.alignment.insertProposal(proposal);
    repos.alignment.merge(candidate.source.id, candidate.target.id, displayName, proposal.id, at);
    return proposal;
  }

  return {
    /** Canonical concepts + proposals for the alignment review UI. */
    overview(workspaceId: string): AlignmentOverview {
      requireWorkspace(workspaceId);
      ensureBaseline(workspaceId);
      const proposals = repos.alignment.listProposals(workspaceId);
      return {
        canonical: repos.alignment.listCanonical(workspaceId),
        pendingProposals: proposals.filter((p) => p.status === 'proposed'),
        decidedProposals: proposals.filter((p) => p.status !== 'proposed'),
      };
    },

    /**
     * Run one alignment round: deterministic candidates → auto-accept the
     * exact-normalization rule → offer the remaining bounded candidates to
     * Hy3 → validate every returned proposal locally → persist as 'proposed'.
     * Failed provider calls change nothing that was not already decided.
     */
    async propose(
      workspaceId: string,
      opts?: ProviderCallOptions,
    ): Promise<AlignmentProposalRunResult> {
      requireWorkspace(workspaceId);
      const concepts = ensureBaseline(workspaceId);
      const blocks = repos.materials.getBlocksByWorkspace(workspaceId);
      const blockById = new Map(blocks.map((b) => [b.id, b]));
      const titles = conceptTitleMap(workspaceId);

      const headingByConcept = new Map<string, string>();
      for (const concept of concepts) {
        const block = blockById.get(concept.grounding.blockId);
        if (block && block.headingPath.length > 0) {
          headingByConcept.set(concept.id, block.headingPath.join(' / '));
        }
      }
      const canonicalByConcept = new Map<string, string>();
      for (const view of repos.alignment.listCanonical(workspaceId)) {
        for (const member of view.members) {
          canonicalByConcept.set(member.sourceConceptId, view.id);
        }
      }
      const existingPairKeys = new Set<string>();
      const knownAliasKeyPairs = new Set<string>();
      const conceptById = new Map(concepts.map((c) => [c.id, c]));
      for (const proposal of repos.alignment.listProposals(workspaceId)) {
        existingPairKeys.add(pairKey(proposal.sourceConceptId, proposal.targetConceptId));
        if (proposal.status === 'accepted') {
          const source = conceptById.get(proposal.sourceConceptId);
          const target = conceptById.get(proposal.targetConceptId);
          if (source && target) {
            knownAliasKeyPairs.add(
              keyPair(normalizeConceptKey(source.name), normalizeConceptKey(target.name)),
            );
          }
        }
      }

      const candidates = generateAlignmentCandidates(concepts, {
        headingByConcept,
        canonicalByConcept,
        existingPairKeys,
        knownAliasKeyPairs,
      });

      const at = clock.now().toISOString();
      const autoAccepted: AlignmentProposal[] = [];
      const providerCandidates: LocalCandidate[] = [];
      for (const candidate of candidates) {
        if (candidate.autoAcceptable) {
          autoAccepted.push(autoAcceptCandidate(workspaceId, candidate, at));
        } else {
          providerCandidates.push(candidate);
        }
      }

      const created: AlignmentProposal[] = [];
      const rejected: AlignmentProposalRunResult['rejected'] = [];

      if (providerCandidates.length > 0) {
        const offered: AlignmentCandidate[] = providerCandidates.map((c) => ({
          source: c.source,
          target: c.target,
          sourceDocumentTitle: titles.get(c.source.materialId) ?? c.source.materialId,
          targetDocumentTitle: titles.get(c.target.materialId) ?? c.target.materialId,
          sourceLanguage: guessConceptLanguage(c.source.name),
          targetLanguage: guessConceptLanguage(c.target.name),
          signals: c.signals,
        }));
        const offeredPairs = new Set(offered.map((c) => pairKey(c.source.id, c.target.id)));

        const payload = await provider.proposeConceptAlignment(
          { workspaceName: repos.workspaces.get(workspaceId)!.name, candidates: offered, blocks },
          opts,
        );

        const decidedAt = clock.now().toISOString();
        const seenPairs = new Set<string>();
        for (const proposed of payload.proposals) {
          const reject = (reason: string) =>
            rejected.push({
              sourceConceptId: proposed.sourceConceptId || null,
              targetConceptId: proposed.targetConceptId || null,
              reason,
            });

          const source = conceptById.get(proposed.sourceConceptId);
          const target = conceptById.get(proposed.targetConceptId);
          if (!source || !target) {
            reject('概念不存在或不属于该课程空间。');
            continue;
          }
          if (source.id === target.id) {
            reject('概念不能与自身对齐。');
            continue;
          }
          const key = pairKey(source.id, target.id);
          if (!offeredPairs.has(key)) {
            reject('提议的概念对不在本地候选列表中。');
            continue;
          }
          if (seenPairs.has(key) || existingPairKeys.has(key)) {
            continue; // duplicate — first proposal wins
          }
          const evidence: VerifiedGrounding[] = [];
          for (const item of proposed.evidence.slice(0, 2)) {
            const verification = verifyGrounding(blocks, item);
            if (verification.ok) evidence.push(verification.grounding);
          }
          if (evidence.length === 0) {
            reject('所有依据引文均未通过原文校验。');
            continue;
          }

          seenPairs.add(key);
          const proposal: AlignmentProposal = {
            id: newId('alp'),
            workspaceId,
            sourceConceptId: source.id,
            targetConceptId: target.id,
            relation: proposed.relation,
            proposedCanonicalName: proposed.canonicalName.trim().slice(0, 80),
            rationale: proposed.rationale,
            evidence,
            origin: 'provider',
            status: 'proposed',
            sourceLanguage: proposed.sourceLanguage ?? guessConceptLanguage(source.name),
            targetLanguage: proposed.targetLanguage ?? guessConceptLanguage(target.name),
            provider: provider.name,
            createdAt: decidedAt,
            decidedAt: null,
          };
          repos.alignment.insertProposal(proposal);
          created.push(proposal);
        }
      }

      return { autoAccepted, created, rejected, candidateCount: candidates.length };
    },

    /**
     * Accept a pending proposal. Merging relations (equivalent/alias) merge
     * the two canonical groups; broader/narrower/related_but_distinct only
     * record the accepted relation. `canonicalName` lets the learner repair
     * malformed names at acceptance time.
     */
    accept(workspaceId: string, proposalId: string, input: unknown): AlignmentOverview {
      requireWorkspace(workspaceId);
      const parsed = AcceptAlignmentRequestSchema.parse(input ?? {});
      const proposal = repos.alignment.getProposal(proposalId);
      if (!proposal || proposal.workspaceId !== workspaceId) {
        throw notFound(`对齐提议不存在:${proposalId}`);
      }
      if (proposal.status !== 'proposed') {
        throw new AppError(
          ApiErrorCode.ValidationError,
          `该提议已处理过(当前状态:${proposal.status}),不能重复决定。`,
        );
      }
      const source = repos.materials.getConcept(proposal.sourceConceptId);
      const target = repos.materials.getConcept(proposal.targetConceptId);
      if (!source || !target) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '提议涉及的概念已被删除,无法接受;请拒绝该提议。',
        );
      }

      ensureBaseline(workspaceId);
      const at = clock.now().toISOString();
      if (MERGING_ALIGNMENT_RELATIONS.includes(proposal.relation)) {
        const displayName = (parsed.canonicalName ?? proposal.proposedCanonicalName).slice(0, 80);
        repos.alignment.merge(source.id, target.id, displayName, proposal.id, at);
      }
      repos.alignment.setProposalStatus(proposal.id, 'accepted', at);
      return this.overview(workspaceId);
    },

    reject(workspaceId: string, proposalId: string): AlignmentOverview {
      requireWorkspace(workspaceId);
      const proposal = repos.alignment.getProposal(proposalId);
      if (!proposal || proposal.workspaceId !== workspaceId) {
        throw notFound(`对齐提议不存在:${proposalId}`);
      }
      if (proposal.status !== 'proposed') {
        throw new AppError(ApiErrorCode.ValidationError, '该提议已处理过,不能重复决定。');
      }
      repos.alignment.setProposalStatus(proposal.id, 'rejected', clock.now().toISOString());
      return this.overview(workspaceId);
    },

    keepSeparate(workspaceId: string, proposalId: string): AlignmentOverview {
      requireWorkspace(workspaceId);
      const proposal = repos.alignment.getProposal(proposalId);
      if (!proposal || proposal.workspaceId !== workspaceId) {
        throw notFound(`对齐提议不存在:${proposalId}`);
      }
      if (proposal.status !== 'proposed') {
        throw new AppError(ApiErrorCode.ValidationError, '该提议已处理过,不能重复决定。');
      }
      repos.alignment.setProposalStatus(proposal.id, 'kept_separate', clock.now().toISOString());
      return this.overview(workspaceId);
    },

    /** Rename a canonical concept (repairs malformed display names). */
    rename(workspaceId: string, canonicalId: string, input: unknown): CanonicalConcept {
      requireWorkspace(workspaceId);
      const parsed = RenameCanonicalConceptRequestSchema.parse(input);
      const canonical = repos.alignment.getCanonical(canonicalId);
      if (!canonical || canonical.workspaceId !== workspaceId) {
        throw notFound(`规范概念不存在:${canonicalId}`);
      }
      return repos.alignment.renameCanonical(
        canonicalId,
        parsed.displayName,
        clock.now().toISOString(),
      )!;
    },
  };
}

export type AlignmentService = ReturnType<typeof createAlignmentService>;
