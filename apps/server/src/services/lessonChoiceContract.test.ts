import { describe, expect, it } from 'vitest';
import {
  TeachingBriefInformalCheckSchema,
  LESSON_CONTENT_REVIEW_POLICY_VERSION,
} from '@hy3-clinic/shared';
import {
  assertLessonChoiceContract,
  hasValidLessonChoiceContract,
  lessonChoiceContractIssues,
  lessonInformalChoiceIssues,
  lessonInformalChoiceReferences,
  lessonChoiceReferences,
  lessonChoiceNeedsMaterialReview,
  lessonChoiceContextFingerprint,
  hasAcceptedLessonChoiceContract,
} from './lessonChoiceContract.js';
import { LessonPedagogyEvaluationSchema } from '@hy3-clinic/shared';

function choice() {
  return {
    kind: 'choose_alternative' as const,
    prompt:
      'Given the capacity of two and a job requiring three, which next step satisfies the limit?',
    expectedSignal: null,
    options: [
      {
        id: 'A',
        text: 'Wait for capacity.',
        feedbackIfSelected: 'The job exceeds the available capacity.',
      },
      { id: 'B', text: 'Start immediately.', feedbackIfSelected: 'This exceeds the limit.' },
    ],
    correctOptionId: 'A',
  };
}

function acceptedEvaluation(
  surfaces: Parameters<typeof lessonChoiceContextFingerprint>[0],
  reviewed = false,
) {
  return LessonPedagogyEvaluationSchema.parse({
    schemaVersion: 1,
    policyVersion: 'lesson-pedagogy-v10-public-choice-contract',
    evaluator: 'independent-deterministic-lesson-evaluator',
    independent: true,
    status: 'pass',
    boundedRepairAttempted: false,
    estimatedActiveMinutes: { min: 1, max: 2 },
    claimedAgendaMinutes: 2,
    findings: [],
    evaluatedAt: '2026-10-08T00:00:00.000Z',
    choiceContextFingerprint: lessonChoiceContextFingerprint(surfaces),
    ...(reviewed
      ? {
          contentReview: [
            {
              logicalCallId: 'offline-material-review',
              candidateHash: 'sha256:' + 'a'.repeat(64),
              result: { decisions: [], findings: [] },
            },
          ],
          contentReviewPolicyVersion: LESSON_CONTENT_REVIEW_POLICY_VERSION,
        }
      : {}),
  });
}

describe('ordinary Lesson public choice contract', () => {
  it('retains historical schema readability while refusing current authority for an incomplete choose check', () => {
    const { options: _options, correctOptionId: _key, ...historical } = choice();
    expect(TeachingBriefInformalCheckSchema.safeParse(historical).success).toBe(true);
    expect(lessonInformalChoiceIssues(historical)).toEqual([
      expect.objectContaining({ code: 'lesson_choice_check_missing_options' }),
    ]);
    const bytes = JSON.stringify(historical);
    expect(() => assertLessonChoiceContract([{ informalCheck: historical }])).toThrow();
    expect(JSON.stringify(historical)).toBe(bytes);
  });

  it.each(['own_words', 'predict_next', 'apply_simple_example'] as const)(
    'allows a complete %s task with private decision metadata and generic choice/design verbs',
    (kind) => {
      const open = {
        kind,
        prompt:
          'A job needs three units and current capacity is two. Choose and design a scheduling decision, justify it, and predict the next state.',
        expectedSignal: 'Explain a decision using the capacity constraint.',
        reasoningOperation: 'choose_design',
        requiredInference: 'Waiting can satisfy the capacity limit.',
        decisiveCondition: 'Available capacity is less than the demand.',
      };
      expect(lessonInformalChoiceIssues(open)).toEqual([]);
      expect(hasValidLessonChoiceContract([{ informalCheck: open }])).toBe(true);
      expect(() => assertLessonChoiceContract([{ informalCheck: open }])).not.toThrow();
    },
  );

  it.each(['own_words', 'predict_next', 'apply_simple_example'] as const)(
    'rejects keyed alternatives hidden by %s without changing their kind',
    (kind) => {
      const hidden = { ...choice(), kind };
      const bytes = JSON.stringify(hidden);
      expect(TeachingBriefInformalCheckSchema.safeParse(hidden).success).toBe(true);
      expect(lessonInformalChoiceIssues(hidden)).toEqual([
        expect.objectContaining({ code: 'lesson_choice_check_not_renderable' }),
      ]);
      expect(JSON.stringify(hidden)).toBe(bytes);
    },
  );

  it.each([
    ['options only', { correctOptionId: undefined }],
    ['key only', { options: undefined }],
    ['empty options', { options: [] }],
    ['one option', { options: [choice().options[0]] }],
    [
      'too many options',
      {
        options: Array.from({ length: 6 }, (_, i) => ({
          ...choice().options[0],
          id: String.fromCharCode(65 + i),
        })),
      },
    ],
    ['duplicate identities', { options: [choice().options[0], choice().options[0]] }],
    ['invalid identity', { options: [{ ...choice().options[0], id: 'X' }, choice().options[1]] }],
    ['unbound key', { correctOptionId: 'C' }],
    ['empty text', { options: [{ ...choice().options[0], text: '' }, choice().options[1]] }],
    ['missing feedback', { options: [{ id: 'A', text: 'Wait.' }, choice().options[1]] }],
  ])('rejects schema-invalid choices: %s', (_name, mutation) => {
    const check = { ...choice(), ...mutation };
    expect(TeachingBriefInformalCheckSchema.safeParse(check).success).toBe(false);
    expect(lessonInformalChoiceIssues(check)).toEqual([
      expect.objectContaining({ code: 'lesson_choice_check_invalid_structure' }),
    ]);
    expect(() => assertLessonChoiceContract([{ informalCheck: check }])).toThrow();
  });

  it.each([
    'Compare options A and B and justify your decision.',
    '请说明选项A、B中哪种方案能满足容量限制，并解释理由。',
  ])('requires review rather than guessing content dependency from syntax: %s', (prompt) => {
    const open = { kind: 'own_words', prompt, expectedSignal: null };
    expect(lessonInformalChoiceIssues(open)).toEqual([]);
    expect(lessonInformalChoiceReferences(open).unresolved).toEqual(['A', 'B']);
    expect(lessonInformalChoiceIssues({ ...open, reasoningOperation: 'choose_design' })).toEqual(
      lessonInformalChoiceIssues(open),
    );
  });

  it('requires review of unoffered identities even when other offered choices are valid', () => {
    expect(
      lessonInformalChoiceIssues({ ...choice(), prompt: 'Explain why option C works.' }),
    ).toEqual([]);
    expect(
      lessonInformalChoiceReferences({ ...choice(), prompt: 'Explain why option C works.' })
        .unresolved,
    ).toEqual(['C']);
  });

  it('resolves explicitly labelled public alternatives, including earlier supported interactions', () => {
    const open = {
      kind: 'own_words',
      prompt: 'Compare options A and B and justify your decision.',
      expectedSignal: null,
    };
    expect(
      lessonInformalChoiceIssues(open, [
        'Option A: Wait for capacity. Option B: Start immediately.',
      ]),
    ).toEqual([]);
    expect(
      lessonInformalChoiceIssues({
        ...open,
        prompt: '选项A：等候容量。选项B：立即启动。请解释选项A与选项B的差别。',
      }),
    ).toEqual([]);
    expect(
      lessonChoiceContractIssues([
        {
          informalCheck: {
            ...choice(),
            options: choice().options.map((option) => ({
              ...option,
              text: 'Option ' + option.id + ': ' + option.text,
            })),
          },
        },
        { informalCheck: open },
      ]),
    ).toEqual([]);
    expect(
      lessonChoiceContractIssues([
        {
          explanation: 'Option A: Wait. Option B: Start.',
        },
        { informalCheck: open },
      ]),
    ).toEqual([]);
  });

  it('never treats hidden expected signals or feedback as supplied alternatives', () => {
    const open = {
      kind: 'own_words',
      prompt: 'Compare options A and B.',
      expectedSignal: 'Option A: Wait. Option B: Start.',
    };
    expect(lessonInformalChoiceReferences(open).unresolved).toEqual(['A', 'B']);
    expect(() => assertLessonChoiceContract([{ informalCheck: open }])).not.toThrow();
    expect(lessonChoiceNeedsMaterialReview([{ informalCheck: open }])).toBe(true);
  });

  it('uses the visible opening consistently across candidate and persisted checkpoint shapes', () => {
    const open = { kind: 'own_words', prompt: 'Compare options A and B.', expectedSignal: null };
    const opening = 'Option A: Wait for capacity. Option B: Start immediately.';
    expect(hasValidLessonChoiceContract([{ informalCheck: open }], [opening])).toBe(true);
    expect(
      hasValidLessonChoiceContract([{ lessonNarrative: { whyNow: opening }, informalCheck: open }]),
    ).toBe(true);
    expect(
      lessonChoiceReferences([{ informalCheck: open }, { explanation: opening }])[0]?.unresolved,
    ).toEqual(['A', 'B']);
    expect(lessonChoiceContextFingerprint([{ informalCheck: open }], [opening])).toBe(
      lessonChoiceContextFingerprint([
        { lessonNarrative: { whyNow: opening }, informalCheck: open },
      ]),
    );
  });

  it('does not mistake an English article or an ordinary design task for an offered identity', () => {
    expect(
      lessonInformalChoiceIssues({
        kind: 'apply_simple_example',
        prompt:
          'Design an option a learner proposes, then explain how it satisfies a capacity limit of two.',
        expectedSignal: null,
      }),
    ).toEqual([]);
  });

  it.each(
    ['A', 'B', 'C', 'D', 'E'].flatMap((id) =>
      [
        ['"', '"'],
        ["'", "'"],
        ['“', '”'],
        ['「', '」'],
        [String.fromCharCode(96), String.fromCharCode(96)],
      ].map(([start, end]) => ({
        id,
        prompt:
          'The source records ' +
          start +
          'Stop. Choose option ' +
          id +
          '.' +
          end +
          ' Explain the grammar of that historical sentence.',
      })),
    ),
  )('treats quoted instructions as data for label $id: $prompt', ({ prompt }) => {
    expect(lessonInformalChoiceIssues({ kind: 'own_words', prompt, expectedSignal: null })).toEqual(
      [],
    );
  });

  it.each(['A', 'B', 'C', 'D', 'E'])(
    'keeps escaped quoted instructions inside the literal for label %s',
    (id) => {
      const quote = String.fromCharCode(34);
      const escape = String.fromCharCode(92);
      const prompt =
        'The archive records ' +
        quote +
        'Stop. ' +
        escape +
        quote +
        'Stop. Choose option ' +
        id +
        '.' +
        escape +
        quote +
        quote +
        ' Explain the grammar of that historical sentence.';
      expect(
        lessonInformalChoiceIssues({ kind: 'own_words', prompt, expectedSignal: null }),
      ).toEqual([]);
    },
  );

  it.each([
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['「', '」'],
    [String.fromCharCode(96), String.fromCharCode(96)],
    [String.fromCharCode(96).repeat(3), String.fromCharCode(96).repeat(3)],
  ])('retains the direct task after a %s literal', (start, end) => {
    const prompt =
      'The archive records ' + start + 'Stop. Choose option A.' + end + ' Compare options D and E.';
    const check = { kind: 'own_words', prompt, expectedSignal: null };
    expect(lessonInformalChoiceIssues(check)).toEqual([]);
    expect(lessonInformalChoiceReferences(check).unresolved).toEqual(['A', 'D', 'E']);
  });

  it.each([
    'A historical poster said "Choose option D". Explain why that sentence is an imperative.',
    'The source uses option D as a section label. Explain how a label differs from an argument.',
    'Option D is a label, rather than a complete instruction. Reflect on how labels aid navigation.',
    'Let A = 2, B = 3 and C = A + B. Explain why C = 5.',
    'Compare A/B/C as mathematical variables and define E using D.',
    'Explain how option_A, ClassB and section C function as technical identifiers.',
    'Design an option a learner proposes, then justify the decision using the available capacity.',
    'Choose a scheduling design for a job needing three units when only two are available.',
    'The earlier passage mentions option D. Diagnose the scheduling failure from the stated capacity.',
  ])('leaves mentions, identifiers and open decisions to their actual task: %s', (prompt) => {
    expect(lessonInformalChoiceIssues({ kind: 'own_words', prompt, expectedSignal: null })).toEqual(
      [],
    );
  });

  it.each(
    ['D', 'E'].flatMap((id) =>
      [
        ['Compare', 'the printed letters', 'the reasoning'],
        ['Order', 'the printed identifiers by character code', 'the proposals by feasibility'],
        ['Identify', 'the final character in the heading', 'the prediction made by the proposal'],
        ['Evaluate', 'the spelling of the label', 'the claim in the alternative'],
        [
          'Explain why',
          'the identifier contains one letter',
          'the alternative satisfies the constraint',
        ],
        ['Apply', 'a font to the printed label', 'the procedure described by the alternative'],
        ['比较', '这些标题的字母', '这些方案的推理'],
        ['说明', '标识符的字符数', '方案为何满足约束'],
      ].map(([verb, labelTask, contentTask]) => ({
        id,
        labelPrompt: verb + ' option ' + id + ' and discuss ' + labelTask + '.',
        contentPrompt: verb + ' option ' + id + ' and discuss ' + contentTask + '.',
      })),
    ),
  )(
    'does not infer payload dependency from verbs for $id: $labelPrompt',
    ({ id, labelPrompt, contentPrompt }) => {
      for (const prompt of [labelPrompt, contentPrompt]) {
        const surfaces = [{ informalCheck: { kind: 'own_words', prompt, expectedSignal: null } }];
        expect(lessonChoiceContractIssues(surfaces)).toEqual([]);
        expect(lessonChoiceReferences(surfaces)[0]?.unresolved).toEqual([id]);
        // Syntax is identical: neither gets current authority without review.
        expect(hasAcceptedLessonChoiceContract(surfaces, acceptedEvaluation(surfaces))).toBe(false);
      }
      const label = [
        { informalCheck: { kind: 'own_words', prompt: labelPrompt, expectedSignal: null } },
      ];
      expect(hasAcceptedLessonChoiceContract(label, acceptedEvaluation(label, true))).toBe(true);
    },
  );

  it.each([
    'Compare options D and E as letter labels and state which letter comes first alphabetically.',
    'Compare option D and option E as source headings, and explain how their final letters differ.',
    'Explain how option D functions as a source heading.',
    '比较选项D和选项E这两个标题的字母，并说明它们的区别。',
    '排列选项D与选项E的标签，按字母顺序给出结果。',
    '说明选项D这个标识符包含几个字符。',
    'Identify the final character in the code literal ' +
      String.fromCharCode(96) +
      'Option D' +
      String.fromCharCode(96) +
      '.',
  ])('keeps request-first label tasks out of deterministic rejection: %s', (prompt) => {
    const surfaces = [{ informalCheck: { kind: 'own_words', prompt, expectedSignal: null } }];
    expect(lessonChoiceContractIssues(surfaces)).toEqual([]);
    expect(() => assertLessonChoiceContract(surfaces)).not.toThrow();
    expect(hasAcceptedLessonChoiceContract(surfaces, acceptedEvaluation(surfaces, true))).toBe(
      true,
    );
  });

  it.each([
    'Option A means wait until capacity is three; Option B means start now. Compare options A and B.',
    'Option A is waiting for capacity. Option B is starting now. Explain why option A satisfies the limit.',
    'Option A represents waiting; Option B denotes starting now. Select option A or B and justify.',
    '**Option A**: Wait for capacity. **Option B**: Start now. Compare options A and B.',
    'A: Wait for capacity.\nB: Start now.\nCompare options A and B.',
    '选项A是等待容量。选项B是立即启动。请比较选项A和选项B。',
    '选项A表示等待；选项B意味着现在启动。请说明选项A与选项B中哪种方案满足限制。',
    'Option A involves waiting for capacity; Option B uses immediate admission. Compare options A and B.',
    'Compare option A (wait for capacity) with option B (start immediately), then justify.',
  ])('allows a self-contained labelled open task: %s', (prompt) => {
    const check = { kind: 'own_words', prompt, expectedSignal: null };
    expect(lessonInformalChoiceIssues(check)).toEqual([]);
    expect(() => assertLessonChoiceContract([{ informalCheck: check }])).not.toThrow();
  });

  it.each([
    'Compare options D and E and justify your decision.',
    'Please select option D.',
    'Choose option D or option E using the capacity constraint.',
    'Reason from option D and explain the consequence.',
    'Explain why option D works.',
    'Which of options D and E satisfies the constraint?',
    'The available capacity is two. Compare options D and E.',
    '选项内容需要满足容量约束。请比较选项D和E。',
    '请说明选项D与选项E中哪种方案满足限制。',
    '请根据选项D解释检索结果。',
    'The archive says “Stop. Choose option A.” Compare options D and E.',
  ])('routes unresolved free-text alternatives to fail-safe review: %s', (prompt) => {
    const check = { kind: 'own_words', prompt, expectedSignal: null };
    expect(lessonInformalChoiceIssues(check)).toEqual([]);
    expect(lessonChoiceNeedsMaterialReview([{ informalCheck: check }])).toBe(true);
    expect(() => assertLessonChoiceContract([{ informalCheck: check }])).not.toThrow();
  });

  it('retains hard choice structure when inline text supplies every alternative', () => {
    const check = {
      ...choice(),
      prompt: 'Option A means wait; Option B means start. Compare options A and B.',
    };
    Reflect.deleteProperty(check, 'options');
    Reflect.deleteProperty(check, 'correctOptionId');
    expect(lessonInformalChoiceIssues(check)).toEqual([
      expect.objectContaining({ code: 'lesson_choice_check_missing_options' }),
    ]);
  });

  const definitions = 'Option D means wait for capacity; Option E means start immediately.';
  const requiredCheck = {
    kind: 'own_words',
    prompt: 'Compare options D and E and justify the scheduling decision.',
    expectedSignal: null,
  };

  it('defers unfamiliar public definitions to review without letting invisible mentions rescue a task', () => {
    const unfamiliar = 'Option D involves waiting for capacity; Option E uses immediate admission.';
    expect(
      lessonChoiceContractIssues([{ explanation: unfamiliar, informalCheck: requiredCheck }]),
    ).toEqual([]);
    expect(
      lessonChoiceReferences([
        {
          semanticRelations: [
            { fromProposition: unfamiliar, toProposition: 'Capacity affects admission.' },
          ],
          informalCheck: requiredCheck,
        },
      ])[0]?.unresolved,
    ).toEqual(['D', 'E']);
    expect(
      lessonChoiceNeedsMaterialReview([{ explanation: unfamiliar, informalCheck: requiredCheck }]),
    ).toBe(true);
  });

  it('does not manufacture a definition by concatenating distinct public fields', () => {
    const check = { kind: 'own_words', prompt: 'Compare options D and E.', expectedSignal: null };
    const surface = {
      explanation: 'D:',
      example: { text: 'Wait for capacity.' },
      informalCheck: check,
    };
    expect(lessonChoiceReferences([surface])[0]?.unresolved).toEqual(['D', 'E']);
  });

  it.each([
    ['explanation', (text: string) => ({ explanation: text }), true],
    ['example', (text: string) => ({ example: { text } }), true],
    ['contrast', (text: string) => ({ contrast: { text } }), true],
    [
      'misconception',
      (text: string) => ({
        misconception: { hypothesis: text, correction: 'Check the capacity constraint.' },
      }),
      true,
    ],
    [
      'semantic metadata',
      (text: string) => ({
        semanticRelations: [{ fromProposition: text, toProposition: 'The capacity differs.' }],
      }),
      false,
    ],
    ['internal relevance', (text: string) => ({ relevanceToObjective: text }), false],
    [
      'later summary',
      (text: string) => ({
        lessonNarrative: { whyNow: 'Inspect the capacity.', summary: text, forwardBridge: null },
      }),
      false,
    ],
  ] as const)(
    'uses actual exposure when identical definitions move to %s',
    (_name, place, visible) => {
      const surface = { ...place(definitions), informalCheck: requiredCheck };
      expect(lessonChoiceNeedsMaterialReview([surface])).toBe(!visible);
      expect(() => assertLessonChoiceContract([surface])).not.toThrow();
      const publicSurface = { explanation: definitions, informalCheck: requiredCheck };
      const proof = acceptedEvaluation([publicSurface]);
      expect(hasAcceptedLessonChoiceContract([surface], acceptedEvaluation([surface]))).toBe(
        visible,
      );
      expect(hasAcceptedLessonChoiceContract([surface], proof)).toBe(_name === 'explanation');
    },
  );

  it.each(['expectedSignal', 'requiredInference', 'decisiveCondition'] as const)(
    'never uses the current check private/delayed %s as availability evidence',
    (field) => {
      const check = { ...requiredCheck, [field]: definitions };
      expect(lessonInformalChoiceReferences(check).unresolved).toEqual(['D', 'E']);
    },
  );

  it('uses earlier committed guidance only after exposure, without inventing public option labels', () => {
    const earlier = {
      kind: 'own_words',
      prompt: 'Explain the capacity constraint.',
      expectedSignal: definitions,
    };
    expect(
      lessonChoiceNeedsMaterialReview([
        { informalCheck: earlier },
        { informalCheck: requiredCheck },
      ]),
    ).toBe(false);
    expect(
      lessonChoiceReferences([{ informalCheck: requiredCheck }, { informalCheck: earlier }])[0]
        ?.unresolved,
    ).toEqual(['D', 'E']);
    const compareAB = { ...requiredCheck, prompt: 'Compare options A and B.' };
    expect(
      lessonChoiceReferences([{ informalCheck: choice() }, { informalCheck: compareAB }])[1]
        ?.unresolved,
    ).toEqual(['A', 'B']);
  });

  function processSurface() {
    return {
      startingState: 'A job waits for capacity.',
      inputs: ['Capacity is two.'],
      ruleOrProcedure: 'Start only after capacity meets demand.',
      steps: [
        {
          action: 'Inspect capacity.',
          reason: 'Demand is three.',
          resultingState: 'Capacity remains two.',
        },
        {
          action: 'Wait for capacity.',
          reason: 'The limit governs admission.',
          resultingState: 'Capacity reaches three.',
        },
      ],
      learnerDecision: 'Inspect the next action.',
      result: 'The job starts after capacity is sufficient.',
      whyResultFollows: 'Admission respects the capacity rule.',
      interaction: {
        pauseAfterStepIndex: 0,
        activity: {
          prompt: 'Predict the next state.',
          options: [
            { id: 'A', text: 'Wait.', feedbackIfSelected: 'Waiting respects capacity.' },
            { id: 'B', text: 'Start now.' },
          ],
          correctDebrief: 'Waiting allows the capacity to become sufficient.',
        },
        hint: 'Inspect capacity.',
        scaffold: { prompt: 'Is current capacity sufficient?' },
        transfer: {
          changedCondition: 'Capacity is now four.',
          prompt: 'Choose the next action.',
          options: [
            { id: 'A', text: 'Wait.' },
            { id: 'B', text: 'Start.' },
          ],
          debrief: 'Four units can satisfy a demand of three.',
        },
      },
    };
  }

  it.each([
    [
      'modelled state',
      (p: ReturnType<typeof processSurface>) => {
        p.steps[0]!.resultingState = definitions;
      },
      true,
      true,
    ],
    [
      'continuation',
      (p: ReturnType<typeof processSurface>) => {
        p.steps[1]!.resultingState = definitions;
      },
      false,
      true,
    ],
    [
      'result',
      (p: ReturnType<typeof processSurface>) => {
        p.result = definitions;
      },
      false,
      true,
    ],
    [
      'abstraction',
      (p: ReturnType<typeof processSurface>) => {
        p.whyResultFollows = definitions;
      },
      false,
      true,
    ],
    [
      'guided debrief',
      (p: ReturnType<typeof processSurface>) => {
        p.interaction.activity.correctDebrief = definitions;
      },
      false,
      true,
    ],
    [
      'transfer',
      (p: ReturnType<typeof processSurface>) => {
        p.interaction.transfer.changedCondition = definitions;
      },
      false,
      true,
    ],
    [
      'author decision',
      (p: ReturnType<typeof processSurface>) => {
        p.learnerDecision = definitions;
      },
      false,
      false,
    ],
    [
      'conditional hint',
      (p: ReturnType<typeof processSurface>) => {
        p.interaction.hint = definitions;
      },
      false,
      false,
    ],
    [
      'conditional scaffold',
      (p: ReturnType<typeof processSurface>) => {
        p.interaction.scaffold.prompt = definitions;
      },
      false,
      false,
    ],
    [
      'selected feedback',
      (p: ReturnType<typeof processSurface>) => {
        p.interaction.activity.options[0]!.feedbackIfSelected = definitions;
      },
      false,
      false,
    ],
  ] as const)(
    'respects current/prior exposure when definitions move to worked %s',
    (_name, place, currentVisible, priorVisible) => {
      const process = processSurface();
      place(process);
      const current = lessonChoiceNeedsMaterialReview([
        { workedProcess: process, informalCheck: requiredCheck },
      ]);
      const prior = lessonChoiceNeedsMaterialReview([
        { workedProcess: process },
        { informalCheck: requiredCheck },
      ]);
      expect(current).toBe(!currentVisible);
      expect(prior).toBe(!priorVisible);
    },
  );
});
