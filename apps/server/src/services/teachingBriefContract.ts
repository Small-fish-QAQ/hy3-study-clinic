import type { TeachingBriefProposalPayload } from '@hy3-clinic/shared';
import type { ProviderCandidateValidation, TeachingBriefGenerationInput } from '../llm/provider.js';
import { evaluateLessonPedagogy, evaluatePracticeQuality } from './lessonPedagogyEvaluator.js';

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
