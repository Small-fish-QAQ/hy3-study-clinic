import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  type TeachingBriefProposalPayload,
  type TeachingLessonSlotContent,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  ProviderCandidateValidation,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import {
  evaluateLessonPedagogy,
  evaluateLessonSlotPedagogy,
  evaluatePlannedPracticeQuality,
  evaluatePracticeQuality,
  lessonEvaluationInvalidSlotIds,
  practiceEvaluationInvalidSlotIds,
} from './lessonPedagogyEvaluator.js';

function allSourceRefs(segment: TeachingBriefProposalPayload['segments'][number]): string[] {
  return [
    ...segment.sourceRefs,
    ...(segment.example?.sourceRefs ?? []),
    ...(segment.contrast?.sourceRefs ?? []),
    ...(segment.misconception?.sourceRefs ?? []),
  ];
}

/** Input-aware validation runs inside the Hy3 one-repair structured boundary. */
export function validateTeachingBriefCandidate(
  candidate: unknown,
  input: TeachingBriefGenerationInput,
): ProviderCandidateValidation {
  const payload = candidate as TeachingBriefProposalPayload;
  const diagnostics: string[] = [];
  const codes: string[] = [];
  const sourceRefs = new Set(input.sourceContext.offers.map((offer) => offer.sourceRef));
  const visualRefs = new Set(
    (input.visualContext?.offers ?? []).map((offer) => offer.referenceKey),
  );
  const objectiveRefs = new Set(
    input.learningUnit.objectives.map((objective) => objective.objectiveRef),
  );
  const prerequisiteRefs = new Set(
    input.prerequisites.map((prerequisite) => prerequisite.prerequisiteRef),
  );
  const seenPrerequisites = new Set<string>();
  for (const prerequisite of payload.prerequisites) {
    if (!prerequisiteRefs.has(prerequisite.prerequisiteRef)) {
      diagnostics.push(`Unknown prerequisite ref: ${prerequisite.prerequisiteRef}.`);
      codes.push('unknown_prerequisite_ref');
    }
    if (seenPrerequisites.has(prerequisite.prerequisiteRef)) {
      diagnostics.push(`Duplicate prerequisite ref: ${prerequisite.prerequisiteRef}.`);
      codes.push('duplicate_prerequisite_ref');
    }
    seenPrerequisites.add(prerequisite.prerequisiteRef);
  }

  const seenIntents = new Set<string>();
  const coveredObjectives = new Set<string>();
  for (const [index, segment] of payload.segments.entries()) {
    const intent = `${segment.purpose}:${segment.explanation.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seenIntents.has(intent)) {
      diagnostics.push(`Duplicate teaching segment intent at index ${index}.`);
      codes.push('duplicate_teaching_intent');
    }
    seenIntents.add(intent);
    for (const objectiveRef of segment.objectiveRefs) {
      if (!objectiveRefs.has(objectiveRef)) {
        diagnostics.push(`Unknown objective ref: ${objectiveRef}.`);
        codes.push('unknown_objective_ref');
      } else {
        coveredObjectives.add(objectiveRef);
      }
    }
    for (const ref of allSourceRefs(segment)) {
      if (!sourceRefs.has(ref)) {
        diagnostics.push(`Unknown source ref: ${ref}.`);
        codes.push('unknown_source_ref');
      }
    }
    if (
      segment.explanationAuthority === 'source_backed_teaching' &&
      segment.sourceRefs.length === 0
    ) {
      diagnostics.push(`Source-backed segment ${index} has no source refs.`);
      codes.push('unsupported_source_backed_claim');
    }
    for (const illustration of [segment.example, segment.contrast]) {
      if (
        illustration?.authority === 'source_backed_teaching' &&
        illustration.sourceRefs.length === 0
      ) {
        diagnostics.push(`Source-backed illustration in segment ${index} has no source refs.`);
        codes.push('unsupported_source_backed_claim');
      }
    }
  }
  for (const objectiveRef of objectiveRefs) {
    if (!coveredObjectives.has(objectiveRef)) {
      diagnostics.push(`Teaching sequence omits objective ref: ${objectiveRef}.`);
      codes.push('objective_not_covered');
    }
  }
  if (
    (input.visualContext?.offers.length ?? 0) === 0 &&
    !payload.segments.some((segment) => segment.sourceRefs.length > 0)
  ) {
    diagnostics.push('Teaching sequence must contain at least one source-referenced segment.');
    codes.push('no_source_backed_segment');
  }

  for (const [itemIndex, item] of payload.practice.items.entries()) {
    if (!objectiveRefs.has(item.objectiveRef)) {
      diagnostics.push(`Unknown Practice objective ref: ${item.objectiveRef}.`);
      codes.push('unknown_practice_objective_ref');
    }
    for (const ref of item.sourceRefs) {
      if (!sourceRefs.has(ref)) {
        diagnostics.push(`Unknown Practice source ref at item ${itemIndex}: ${ref}.`);
        codes.push('unknown_practice_source_ref');
      }
    }
    for (const ref of item.visualRefs) {
      if (!visualRefs.has(ref)) {
        diagnostics.push(`Unknown Practice visual ref at item ${itemIndex}: ${ref}.`);
        codes.push('unknown_practice_visual_ref');
      }
    }
  }

  let lessonEvaluation: ReturnType<typeof evaluateLessonPedagogy> | undefined;
  let practiceEvaluation: ReturnType<typeof evaluatePracticeQuality> | undefined;
  if (diagnostics.length === 0) {
    const evaluatedAt = '1970-01-01T00:00:00.000Z';
    lessonEvaluation = evaluateLessonPedagogy(payload, input, { evaluatedAt });
    practiceEvaluation = evaluatePracticeQuality(payload, input, { evaluatedAt });
    for (const finding of [...lessonEvaluation.findings, ...practiceEvaluation.findings]) {
      if (finding.severity !== 'error') continue;
      diagnostics.push(finding.message);
      codes.push(finding.code);
    }
  }

  const safeSourceAliases = (objectiveRef: string) =>
    input.sourceContext.offers
      .filter((offer) => offer.authorizedObjectiveRefs.includes(objectiveRef))
      .slice(0, 8)
      .map((offer) => ({ sourceRef: offer.sourceRef, text: offer.text.slice(0, 600) }));
  const semanticFindings = [
    ...(lessonEvaluation?.findings ?? []),
    ...(practiceEvaluation?.findings ?? []),
  ].filter((finding) => finding.severity === 'error');
  const structuredDiagnostics = semanticFindings.map((finding) => {
    const segmentIndexes = 'segmentIndexes' in finding ? finding.segmentIndexes : [];
    const itemIndexes = 'itemIndexes' in finding ? finding.itemIndexes : [];
    const objectiveRefs = finding.objectiveRefs;
    const facts: Record<string, string | number | boolean | null | string[] | object> = {
      objectiveRefs,
    };
    if (segmentIndexes.length > 0) {
      facts.segmentIndexes = segmentIndexes;
      facts.currentExplanation = segmentIndexes
        .map((index) => payload.segments[index]?.explanation.slice(0, 700))
        .filter(Boolean)
        .join(' | ');
      facts.missingRelationship =
        'Make one source-supported relation observable: cause/consequence, mechanism/effect, condition/decision, step/why, misconception/correction, comparison, or evidence/conclusion.';
      facts.safeSourceContext = objectiveRefs.flatMap(safeSourceAliases).slice(0, 8);
    }
    if (finding.code === 'agenda_duration_not_supported_by_learning_actions') {
      facts.targetMinutes = input.durationBudget?.targetMinutes ?? input.plannedMinutes;
      facts.derivedRange = lessonEvaluation?.estimatedActiveMinutes ?? null;
      facts.direction = lessonEvaluation
        ? lessonEvaluation.estimatedActiveMinutes.min > input.plannedMinutes
          ? 'over_budget'
          : 'under_budget'
        : null;
      facts.protectedRoles = input.durationBudget?.protectedRoles ?? [
        'objective_orientation',
        'explanation',
        'worked_example',
        'guided_practice',
      ];
      facts.protectedObjectiveRefs = input.durationBudget?.protectedObjectiveRefs ?? [];
      facts.reductionOrder = input.durationBudget?.reductionOrder ?? [];
    }
    if (itemIndexes.length > 0) {
      facts.itemIndexes = itemIndexes;
      facts.currentPrompts = itemIndexes
        .map((index) => payload.practice.items[index]?.initial.prompt.slice(0, 700))
        .filter(Boolean);
      facts.targetConstructs = objectiveRefs.map(
        (objectiveRef) =>
          input.learningUnit.objectives.find((objective) => objective.objectiveRef === objectiveRef)
            ?.construct ?? null,
      );
      facts.allowedEvidenceAliases = objectiveRefs.flatMap(safeSourceAliases).slice(0, 8);
      facts.allowedApplyForms = [
        'choose the correct next step under an exact source-stated state',
        'order source-stated procedural steps',
        'detect a missing or wrong procedural step',
        'complete a source-stated sequence',
        'apply a stated condition to determine an action',
        'diagnose why a bounded source-stated procedure fails',
      ];
      facts.prohibitedForApply = [
        'recall a procedure name',
        'recognize a definition',
        'locate a paragraph or page',
        'repeat a sequence without an action or decision',
        'unsupported transfer or design',
      ];
      if (finding.code === 'practice_source_outside_objective_authority') {
        facts.selectedSourceRefs = itemIndexes.flatMap(
          (index) => payload.practice.items[index]?.sourceRefs ?? [],
        );
      }
    }
    return { code: finding.code, message: finding.message, facts };
  });
  if (semanticFindings.length > 0) {
    diagnostics.push(...structuredDiagnostics.map((finding) => finding.message));
    codes.push(...structuredDiagnostics.map((finding) => finding.code));
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].slice(0, 20),
    diagnosticCodes: [...new Set(codes)].slice(0, 20),
    ...(diagnostics.length > 0
      ? {
          failureArtifact: {
            kind: 'lesson_practice_quality_rejection',
            context: {
              learningUnitTitle: input.learningUnit.title,
              claimedAgendaMinutes: input.plannedMinutes,
              segmentCount: payload.segments.length,
              practiceItemCount: payload.practice.items.length,
            },
            diagnostics:
              structuredDiagnostics.length > 0
                ? structuredDiagnostics.slice(0, 20)
                : [...new Set(diagnostics)].slice(0, 20).map((message, index) => ({
                    code: [...new Set(codes)][index] ?? 'lesson_practice_quality_rejection',
                    message,
                  })),
          },
        }
      : {}),
  };
}

interface CompositionalDiagnostic {
  code: string;
  message: string;
  itemIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicateIds(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function compositionValidationResult(options: {
  kind: 'lesson_slot_content_rejection' | 'practice_content_rejection';
  skeletonId: string;
  expectedIds: string[];
  presentIds: string[];
  invalidIds: Set<string>;
  diagnostics: CompositionalDiagnostic[];
}): ProviderCandidateValidation {
  const uniqueDiagnostics = options.diagnostics.filter(
    (diagnostic, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === diagnostic.code &&
          candidate.message === diagnostic.message &&
          candidate.itemIds.join('|') === diagnostic.itemIds.join('|'),
      ) === index,
  );
  if (uniqueDiagnostics.length === 0) {
    return { valid: true, diagnostics: [], diagnosticCodes: [] };
  }

  const presentCounts = new Map<string, number>();
  for (const id of options.presentIds) {
    presentCounts.set(id, (presentCounts.get(id) ?? 0) + 1);
  }
  const invalidItemIds = orderedUnique([
    ...options.expectedIds.filter((id) => options.invalidIds.has(id)),
    ...options.presentIds.filter((id) => options.invalidIds.has(id)),
    ...options.invalidIds,
  ]);
  const frozenValidItemIds = options.expectedIds.filter(
    (id) => !options.invalidIds.has(id) && presentCounts.get(id) === 1,
  );
  return {
    valid: false,
    diagnostics: orderedUnique(uniqueDiagnostics.map((diagnostic) => diagnostic.message)).slice(
      0,
      20,
    ),
    diagnosticCodes: orderedUnique(uniqueDiagnostics.map((diagnostic) => diagnostic.code)).slice(
      0,
      20,
    ),
    failureArtifact: {
      kind: options.kind,
      context: {
        skeletonId: options.skeletonId,
        expectedItemIds: options.expectedIds,
        invalidItemIds,
        frozenValidItemIds,
      },
      diagnostics: uniqueDiagnostics.slice(0, 20).map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        facts: { itemIds: diagnostic.itemIds },
      })),
    },
    ...(invalidItemIds.length > 0 ? { targetedRepair: { invalidItemIds } } : {}),
  };
}

function lessonContentSourceRefs(content: TeachingLessonSlotContent): string[] {
  return [
    ...content.sourceRefs,
    ...content.semanticRelations.flatMap((relation) => relation.sourceRefs),
    ...(content.workedProcess?.sourceRefs ?? []),
    ...(content.example?.sourceRefs ?? []),
    ...(content.contrast?.sourceRefs ?? []),
    ...(content.misconception?.sourceRefs ?? []),
  ];
}

function lessonContentVisualRefs(content: TeachingLessonSlotContent): string[] {
  return [
    ...content.visualRefs,
    ...(content.example?.visualRefs ?? []),
    ...(content.contrast?.visualRefs ?? []),
    ...(content.misconception?.visualRefs ?? []),
  ];
}

const LESSON_FORBIDDEN_LOCAL_KEYS = new Set([
  'objectiveRef',
  'objectiveRefs',
  'construct',
  'role',
  'purpose',
  'authority',
  'authorityMode',
  'protected',
  'activityBudget',
  'duration',
  'learnerActionRequired',
  'qualityContract',
  'allowedRelations',
  'allowedSourceRefs',
  'allowedVisualRefs',
  'practice',
  'formalOpportunities',
  'mastery',
  'progression',
  'credit',
]);

const PRACTICE_FORBIDDEN_LOCAL_KEYS = new Set([
  'objectiveRef',
  'objectiveRefs',
  'construct',
  'role',
  'purpose',
  'authority',
  'authorityMode',
  'protected',
  'activityBudget',
  'duration',
  'retryPermitted',
  'capabilityToObserve',
  'prohibitedStrongerConstructs',
  'allowedSourceRefs',
  'allowedVisualRefs',
  'formalEvidence',
  'mastery',
  'progression',
  'credit',
]);

/** Validate only provider-fillable Lesson content against immutable local slots. */
export function validateLessonSlotContentCandidate(
  candidate: unknown,
  input: LessonSlotContentGenerationInput,
): ProviderCandidateValidation {
  const expectedIds = input.skeleton.lessonSlots.map((slot) => slot.slotId);
  const expected = new Set(expectedIds);
  const rawSlots = isRecord(candidate) && Array.isArray(candidate.slots) ? candidate.slots : [];
  const presentIds = rawSlots.flatMap((value) => {
    if (!isRecord(value) || typeof value.slotId !== 'string') return [];
    return [value.slotId];
  });
  const invalidIds = new Set<string>();
  const diagnostics: CompositionalDiagnostic[] = [];

  if (!isRecord(candidate) || !Array.isArray(candidate.slots)) {
    expectedIds.forEach((id) => invalidIds.add(id));
    diagnostics.push({
      code: 'invalid_lesson_slot_content_shape',
      message: 'Lesson content must contain the complete bounded slots collection.',
      itemIds: expectedIds,
    });
  }
  for (const missing of expectedIds.filter((id) => !presentIds.includes(id))) {
    invalidIds.add(missing);
    diagnostics.push({
      code: 'missing_lesson_slot',
      message: `Missing immutable Lesson slot ${missing}.`,
      itemIds: [missing],
    });
  }
  for (const unknown of presentIds.filter((id) => !expected.has(id))) {
    invalidIds.add(unknown);
    diagnostics.push({
      code: 'unknown_lesson_slot',
      message: `Unknown Lesson slot ${unknown} is outside the immutable skeleton.`,
      itemIds: [unknown],
    });
  }
  for (const duplicate of duplicateIds(presentIds)) {
    invalidIds.add(duplicate);
    diagnostics.push({
      code: 'duplicate_lesson_slot',
      message: `Lesson slot ${duplicate} is duplicated.`,
      itemIds: [duplicate],
    });
  }
  for (const raw of rawSlots) {
    if (!isRecord(raw) || typeof raw.slotId !== 'string') continue;
    if ([...LESSON_FORBIDDEN_LOCAL_KEYS].some((key) => key in raw)) {
      invalidIds.add(raw.slotId);
      diagnostics.push({
        code: 'lesson_attempted_local_authority_mutation',
        message: `${raw.slotId} includes objective, construct, role, duration, or authority fields owned only by the immutable skeleton.`,
        itemIds: [raw.slotId],
      });
    }
  }

  const parsed = LessonSlotContentProposalPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 8)) {
      const itemIndex =
        issue.path[0] === 'slots' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
      const itemId =
        itemIndex !== null && isRecord(rawSlots[itemIndex])
          ? rawSlots[itemIndex]!.slotId
          : undefined;
      const issueIds = typeof itemId === 'string' ? [itemId] : expectedIds;
      issueIds.forEach((id) => invalidIds.add(id));
      diagnostics.push({
        code: 'invalid_lesson_slot_content_shape',
        message: `Lesson slot content shape is invalid at ${issue.path.join('.') || 'root'}.`,
        itemIds: issueIds,
      });
    }
    return compositionValidationResult({
      kind: 'lesson_slot_content_rejection',
      skeletonId: input.skeleton.id,
      expectedIds,
      presentIds,
      invalidIds,
      diagnostics,
    });
  }

  const offeredSources = new Set(input.sourceContext.offers.map((offer) => offer.sourceRef));
  const offeredVisuals = new Set(
    (input.visualContext?.offers ?? []).map((offer) => offer.referenceKey),
  );
  const slotsById = new Map(input.skeleton.lessonSlots.map((slot) => [slot.slotId, slot]));
  for (const content of parsed.data.slots) {
    const slot = slotsById.get(content.slotId);
    if (!slot) continue;
    const sourceRefs = lessonContentSourceRefs(content);
    const visualRefs = lessonContentVisualRefs(content);
    if (
      sourceRefs.some(
        (sourceRef) =>
          !slot.allowedSourceRefs.includes(sourceRef) || !offeredSources.has(sourceRef),
      )
    ) {
      invalidIds.add(content.slotId);
      diagnostics.push({
        code: 'lesson_source_alias_outside_slot_authority',
        message: `${content.slotId} selects a source alias outside its immutable local authority.`,
        itemIds: [content.slotId],
      });
    }
    if (
      visualRefs.some(
        (visualRef) =>
          !slot.allowedVisualRefs.includes(visualRef) || !offeredVisuals.has(visualRef),
      )
    ) {
      invalidIds.add(content.slotId);
      diagnostics.push({
        code: 'lesson_visual_alias_outside_slot_authority',
        message: `${content.slotId} selects a visual alias outside its immutable local authority.`,
        itemIds: [content.slotId],
      });
    }
    if (slot.authorityMode === 'exact_source' && sourceRefs.length === 0) {
      invalidIds.add(content.slotId);
      diagnostics.push({
        code: 'lesson_exact_source_slot_has_no_source',
        message: `${content.slotId} requires at least one locally allowed exact source alias.`,
        itemIds: [content.slotId],
      });
    }
    if (
      slot.authorityMode === 'advisory_visual' &&
      (visualRefs.length === 0 || sourceRefs.length > 0)
    ) {
      invalidIds.add(content.slotId);
      diagnostics.push({
        code: 'lesson_advisory_visual_authority_invalid',
        message: `${content.slotId} must remain inside its advisory visual-only authority.`,
        itemIds: [content.slotId],
      });
    }
  }

  const evaluation = evaluateLessonSlotPedagogy(parsed.data, input, {
    evaluatedAt: '1970-01-01T00:00:00.000Z',
  });
  const evaluatedInvalidIds = lessonEvaluationInvalidSlotIds(evaluation, input);
  if (evaluation.status === 'fail' && evaluatedInvalidIds.length === 0) {
    expectedIds.forEach((id) => invalidIds.add(id));
  } else {
    evaluatedInvalidIds.forEach((id) => invalidIds.add(id));
  }
  for (const finding of evaluation.findings.filter((entry) => entry.severity === 'error')) {
    const findingIds = finding.segmentIndexes
      .map((index) => input.skeleton.lessonSlots[index]?.slotId)
      .filter((slotId): slotId is string => Boolean(slotId));
    diagnostics.push({
      code: finding.code,
      message: finding.message,
      itemIds: findingIds.length > 0 ? findingIds : expectedIds,
    });
  }

  return compositionValidationResult({
    kind: 'lesson_slot_content_rejection',
    skeletonId: input.skeleton.id,
    expectedIds,
    presentIds,
    invalidIds,
    diagnostics,
  });
}

/** Validate only provider-fillable Practice content against the immutable plan. */
export function validatePracticeContentCandidate(
  candidate: unknown,
  input: PracticeContentGenerationInput,
): ProviderCandidateValidation {
  const expectedIds = input.skeleton.practicePlan.slots.map((slot) => slot.practiceSlotId);
  const expected = new Set(expectedIds);
  const rawItems = isRecord(candidate) && Array.isArray(candidate.items) ? candidate.items : [];
  const presentIds = rawItems.flatMap((value) => {
    if (!isRecord(value) || typeof value.practiceSlotId !== 'string') return [];
    return [value.practiceSlotId];
  });
  const invalidIds = new Set<string>();
  const diagnostics: CompositionalDiagnostic[] = [];

  if (!isRecord(candidate) || !Array.isArray(candidate.items)) {
    expectedIds.forEach((id) => invalidIds.add(id));
    diagnostics.push({
      code: 'invalid_practice_content_shape',
      message: 'Practice content must contain the complete bounded items collection.',
      itemIds: expectedIds,
    });
  }
  for (const missing of expectedIds.filter((id) => !presentIds.includes(id))) {
    invalidIds.add(missing);
    diagnostics.push({
      code: 'missing_practice_slot',
      message: `Missing immutable Practice slot ${missing}.`,
      itemIds: [missing],
    });
  }
  for (const unknown of presentIds.filter((id) => !expected.has(id))) {
    invalidIds.add(unknown);
    diagnostics.push({
      code: 'unknown_practice_slot',
      message: `Unknown Practice slot ${unknown} is outside the immutable plan.`,
      itemIds: [unknown],
    });
  }
  for (const duplicate of duplicateIds(presentIds)) {
    invalidIds.add(duplicate);
    diagnostics.push({
      code: 'duplicate_practice_slot',
      message: `Practice slot ${duplicate} is duplicated.`,
      itemIds: [duplicate],
    });
  }
  for (const raw of rawItems) {
    if (!isRecord(raw) || typeof raw.practiceSlotId !== 'string') continue;
    if ([...PRACTICE_FORBIDDEN_LOCAL_KEYS].some((key) => key in raw)) {
      invalidIds.add(raw.practiceSlotId);
      diagnostics.push({
        code: 'practice_attempted_local_authority_mutation',
        message: `${raw.practiceSlotId} includes objective, construct, duration, retry, or authority fields owned only by the immutable Practice plan.`,
        itemIds: [raw.practiceSlotId],
      });
    }
  }

  const parsed = PracticeContentProposalPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 8)) {
      const itemIndex =
        issue.path[0] === 'items' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
      const itemId =
        itemIndex !== null && isRecord(rawItems[itemIndex])
          ? rawItems[itemIndex]!.practiceSlotId
          : undefined;
      const issueIds = typeof itemId === 'string' ? [itemId] : expectedIds;
      issueIds.forEach((id) => invalidIds.add(id));
      diagnostics.push({
        code: 'invalid_practice_content_shape',
        message: `Practice content shape is invalid at ${issue.path.join('.') || 'root'}.`,
        itemIds: issueIds,
      });
    }
    return compositionValidationResult({
      kind: 'practice_content_rejection',
      skeletonId: input.skeleton.id,
      expectedIds,
      presentIds,
      invalidIds,
      diagnostics,
    });
  }

  const offeredSources = new Set(input.sourceContext.offers.map((offer) => offer.sourceRef));
  const offeredVisuals = new Set(
    (input.visualContext?.offers ?? []).map((offer) => offer.referenceKey),
  );
  const slotsById = new Map(
    input.skeleton.practicePlan.slots.map((slot) => [slot.practiceSlotId, slot]),
  );
  for (const item of parsed.data.items) {
    const slot = slotsById.get(item.practiceSlotId);
    if (!slot) continue;
    if (
      item.sourceRefs.some(
        (sourceRef) =>
          !slot.allowedSourceRefs.includes(sourceRef) || !offeredSources.has(sourceRef),
      )
    ) {
      invalidIds.add(item.practiceSlotId);
      diagnostics.push({
        code: 'practice_source_alias_outside_slot_authority',
        message: `${item.practiceSlotId} selects a source alias outside its immutable local authority.`,
        itemIds: [item.practiceSlotId],
      });
    }
    if (
      item.visualRefs.some(
        (visualRef) =>
          !slot.allowedVisualRefs.includes(visualRef) || !offeredVisuals.has(visualRef),
      )
    ) {
      invalidIds.add(item.practiceSlotId);
      diagnostics.push({
        code: 'practice_visual_alias_outside_slot_authority',
        message: `${item.practiceSlotId} selects a visual alias outside its immutable local authority.`,
        itemIds: [item.practiceSlotId],
      });
    }
    if (slot.authorityMode === 'exact_source' && item.sourceRefs.length === 0) {
      invalidIds.add(item.practiceSlotId);
      diagnostics.push({
        code: 'practice_exact_source_slot_has_no_source',
        message: `${item.practiceSlotId} requires at least one locally allowed exact source alias.`,
        itemIds: [item.practiceSlotId],
      });
    }
    if (
      slot.authorityMode === 'advisory_visual' &&
      (item.visualRefs.length === 0 || item.sourceRefs.length > 0)
    ) {
      invalidIds.add(item.practiceSlotId);
      diagnostics.push({
        code: 'practice_advisory_visual_authority_invalid',
        message: `${item.practiceSlotId} must remain inside its advisory visual-only authority.`,
        itemIds: [item.practiceSlotId],
      });
    }
  }

  const evaluation = evaluatePlannedPracticeQuality(parsed.data, input, {
    evaluatedAt: '1970-01-01T00:00:00.000Z',
  });
  const evaluatedInvalidIds = practiceEvaluationInvalidSlotIds(evaluation, input);
  if (evaluation.status === 'fail' && evaluatedInvalidIds.length === 0) {
    expectedIds.forEach((id) => invalidIds.add(id));
  } else {
    evaluatedInvalidIds.forEach((id) => invalidIds.add(id));
  }
  for (const finding of evaluation.findings.filter((entry) => entry.severity === 'error')) {
    const findingIds = finding.itemIndexes
      .map((index) => input.skeleton.practicePlan.slots[index]?.practiceSlotId)
      .filter((slotId): slotId is string => Boolean(slotId));
    diagnostics.push({
      code: finding.code,
      message: finding.message,
      itemIds: findingIds.length > 0 ? findingIds : expectedIds,
    });
  }

  return compositionValidationResult({
    kind: 'practice_content_rejection',
    skeletonId: input.skeleton.id,
    expectedIds,
    presentIds,
    invalidIds,
    diagnostics,
  });
}
