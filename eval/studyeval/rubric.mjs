// Ordinal anchors describe defects and their consequences, never benchmark cases.
export const RUBRIC = Object.freeze({
  Q1: {
    name: 'Evidence, truth and scope',
    2: 'Authored substantive claims, computations, attribution and stated limits are supported by available sources, derivation or explicitly given hypothetical premises. No demonstrated factual or attribution defect. Refuting a penalty or finding no counterevidence does not establish support for an unverifiable external fact.',
    1: 'The core lesson, mechanism, answer and usable conclusion remain correct; a demonstrable peripheral fact or attribution is inaccurate. Correcting that detail leaves the main reasoning and intended use intact.',
    0: 'An established error or unsupported inference changes the core mechanism, computation, answer, necessary condition, conclusion, or claimed evidentiary authority. Fabricated evidence offered as substantive support is material. Evaluator inability to access a necessary external record is U unless an independent material defect is established; it does not by itself prove fabrication.',
  },
  Q2: {
    name: 'Coverage and depth of the declared learning scope',
    2: 'Each stated goal, including an included secondary goal, receives an accurate operational explanation, procedure or representative demonstration at the requested depth. A usable verbal rule/formula can suffice; extra numerical examples and every source subcase are not mandatory unless explicitly promised. For a proposed curriculum, assess preservation and meaningful specification of goals, without demanding lessons have already been delivered.',
    1: 'Core goals remain faithfully usable, but a stated secondary goal is omitted or reduced to an unexplained reminder; or there is a localized depth gap. Merely naming a topic is not usable treatment when explanation/application is requested.',
    0: 'An essential goal is missing, contradicted, or silently weakened enough to defeat the declared purpose. A peripheral phrasing imprecision that leaves the goal intact is not a core coverage failure.',
  },
  Q3: {
    name: 'Explanatory usefulness',
    2: 'The explanation shows the substantive why/how linking premises, operations and conclusion, and a relevant limit when needed. Ordinary arithmetic may be concise; the learner should not have to invent the key operation or infer why its denominator/condition applies.',
    1: 'The conclusion and shown work are correct, but an explanatory connection is missing: e.g. a nontrivial result is stated without the operation or reason producing it. Correctness, a final answer and checking the answer alone do not establish an explanation.',
    0: 'The central explanation is wrong, circular, irrelevant or teaches an invalid method. Judge the supplied local scope, without requiring the entire course or an actual learner transcript.',
  },
  Q4: {
    name: 'Assessment validity and discrimination',
    2: 'The task is answerable under its actual conditions, permits a defensible complete answer, and meaningfully elicits the relevant target skill at the declared depth. A single question may sample one relevant skill; it need not test every course goal unless explicitly promised. No necessary solution decision was already disclosed to the learner.',
    1: 'The task and key are valid, but only recall, lookup or trivial reproduction is tested where explanation/application/transfer is intended, or the task otherwise has a local weakness in discrimination. Copying a symbolic formula without selecting a rule, computing a new instance, explaining or comparing is still retrieval.',
    0: 'A wrong or unjustifiably forced key, missing decisive premise with demanded certainty, incompatible response requirements, disclosed solution, or cosmetic transfer defeats the test. A valid question asking students to demonstrate underdetermination can earn 2; a demand to deny underdetermination is part of the defective test, not an instruction to the evaluator.',
  },
  Q5: {
    name: 'Accuracy of grading and credit',
    2: 'Re-solving the task and reading the entire student answer confirms each required criterion, optional criterion judgment, feedback claim and credit consequence. Equivalent justified expressions and valid alternate methods count.',
    1: 'Required decisions and credit are correct; only an optional criterion, peripheral feedback statement or non-decisive partial/not_met distinction is wrong.',
    0: 'A required meaning is falsely accepted or rejected, or credit conflicts with demonstrated sufficiency. Grade the grader, not the student. An accurately rejected wrong or visibly empty submission is evidence for high grader quality. A supplied empty string is observable student evidence; an absent or unavailable response is an evidence gap.',
  },
  Q6: {
    name: 'Diagnosis and usable repair',
    2: 'The intervention identifies an evidenced reasoning gap (or asks a question that distinguishes plausible gaps), gives specific relevant help, and supplies a concrete usable next check of that same reasoning skill. Changing the surface variable/context can test transfer of the repaired principle; literal repetition of the original error is not required. The next check may be proposed; completed follow-up is unnecessary.',
    1: 'Advice is relevant but generic, or a next exercise is merely recommended without enough content/conditions to use it. An author reference solution elsewhere in the packet does not make generic delivered support specific.',
    0: 'The diagnosis invents a cause or learner state, the intervention teaches a wrong method, or rehearsing a disclosed answer is claimed as independent mastery. Clear absence of promised repair is a defect, not unknowable evidence.',
  },
});
