import type { TeachingBrief } from './teachingBrief.js';

/** The unanswered Practice projection: no author metadata or delayed assistance. */
export function projectLearnerPracticeSurface(surface: {
  prompt: string;
  options: ReadonlyArray<{ id: string; text: string }>;
}) {
  return {
    prompt: surface.prompt,
    options: surface.options.map(({ id, text }) => ({ id, text })),
  };
}

export type LearnerPracticeSolvingSurface = ReturnType<typeof projectLearnerPracticeSurface>;

/**
 * Teaching guaranteed visible before Practice unlocks: every Lesson segment and
 * interaction must be completed first. Conditional scaffolds, hints, selected
 * feedback, author decisions and unreferenced source offers are deliberately
 * absent. This is the stable subset of lessonExecution.projectLesson, not the
 * raw authored checkpoint or the private checkpoint-to-Brief assembly.
 */
export function projectPracticePriorTeaching(
  lesson: Pick<
    TeachingBrief,
    | 'objective'
    | 'prerequisites'
    | 'segments'
    | 'summary'
    | 'nextConnection'
    | 'sourceReferences'
    | 'visualReferences'
  >,
) {
  const references = new Map(lesson.sourceReferences.map((ref) => [ref.refId, ref.quote]));
  const sources = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const exactExcerpt = references.get(id);
      return exactExcerpt === undefined ? [] : [{ exactExcerpt }];
    });
  const illustration = (value: TeachingBrief['segments'][number]['example']) =>
    value ? { text: value.text, sources: sources(value.sourceRefIds) } : null;
  return {
    objective: {
      title: lesson.objective.title,
      whyNow: lesson.objective.whyNow,
      outcomes: lesson.objective.objectives.map(({ title, description }) => ({
        title,
        description,
      })),
    },
    prerequisites: lesson.prerequisites.map(({ title, reason, readinessHint }) => ({
      title,
      reason,
      readinessHint,
    })),
    segments: lesson.segments.map((segment) => {
      const process = segment.workedProcess;
      return {
        explanation: segment.explanation,
        sources: sources(segment.sourceRefIds),
        semanticRelations: (segment.semanticRelations ?? []).map(
          ({ kind, fromProposition, toProposition, sourceRefIds }) => ({
            kind,
            fromProposition,
            toProposition,
            sources: sources(sourceRefIds),
          }),
        ),
        example: illustration(segment.example),
        contrast: illustration(segment.contrast),
        possibleMisconception: segment.misconception
          ? {
              hypothesis: segment.misconception.hypothesis,
              correction: segment.misconception.correction,
              sources: sources(segment.misconception.sourceRefIds),
            }
          : null,
        workedProcess: process
          ? {
              startingState: process.startingState,
              inputs: [...(process.inputs ?? [])],
              ruleOrProcedure: process.ruleOrProcedure,
              steps: process.steps.map(({ action, reason, resultingState }) => ({
                action,
                reason,
                resultingState,
              })),
              learnerDecision: process.interaction ? null : process.learnerDecision,
              result: process.result,
              whyResultFollows: process.whyResultFollows,
              sources: sources(process.sourceRefIds),
              interactionSources: sources(process.interaction?.sourceRefs ?? []),
              activity: process.interaction
                ? projectLearnerPracticeSurface(process.interaction.activity)
                : null,
              transfer: process.interaction
                ? {
                    changedCondition: process.interaction.transfer.changedCondition,
                    ...projectLearnerPracticeSurface(process.interaction.transfer),
                  }
                : null,
            }
          : null,
        informalCheck: segment.informalCheck
          ? projectLearnerPracticeSurface({
              prompt: segment.informalCheck.prompt,
              options: segment.informalCheck.options ?? [],
            })
          : null,
      };
    }),
    visuals: lesson.visualReferences.map((reference) => structuredClone(reference.context)),
    summary: { text: lesson.summary, nextConnection: lesson.nextConnection },
  };
}

export type PracticePriorTeaching = ReturnType<typeof projectPracticePriorTeaching>;
