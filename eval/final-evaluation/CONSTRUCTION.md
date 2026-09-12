# Dataset construction and coverage

The final campaign evaluates an open-ended teaching application and its six-dimensional evaluator. Arithmetic examples provide checkable evidence within teaching tasks; the benchmark is not a closed-answer accuracy contest.

## Frozen population

| Collection      | Unique cases | Primary dimension judgments | Construction                                                                                                                                            |
| --------------- | -----------: | --------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled      |           72 |                          72 | Four source contexts per Q1–Q6, each with strong/middle/poor variants: 24 triplets.                                                                     |
| Adversarial     |           24 |                          24 | Four each: padding, jargon, fabricated support, instruction injection, decisive premise changes, prior-solution exposure/cosmetic transfer.             |
| Boundary        |           12 |                          12 | Six honest underdetermination questions and six forced determinate-answer tasks missing decisive premises.                                              |
| Natural product |          101 |                         131 | Prespecified first available product surfaces from 20 real Hy3 course runs. Teaching and Tutor request Q1 and Q3; other surfaces request one dimension. |
| Total           |          209 |                         239 | 70 additional observations repeat 35 inputs, adding 88 dimension judgments: 279 observations / 327 rows overall.                                        |

The target was 36 repeated inputs; one natural source had no Tutor, teaching or curriculum candidate. Its slot stayed unavailable. Scheduled MISSING=0 means all **scheduled observations** completed, not that every desired product surface existed. There were 180 natural record opportunities (nine per course), 101 available and 79 unavailable. Both counts remain public.

## Sources and freshness

Twelve original Chinese instructional roots cover reading/summarization, proportions, causal argument, data interpretation, measurement, descriptive statistics, experimental design, logic, work rates, process scheduling, linear constraints and classification metrics. They were authored for this campaign after the method was frozen. Earlier development/regression and the small fresh checkpoint, including their derived variants, are excluded. Historical source specifications were consulted for exclusion, not as final reference answers.

Four additional roots are exact English excerpts from four OpenStax books: College Physics 2e (conduction), Biology 2e (ecosystem energy), Introductory Statistics 2e (central tendency), and Psychology 2e (memory encoding). Teaching goals and generated product content are Chinese. These are four books from **one publisher**, not four independent publishers. Familiar concepts are not claimed absent from model training.

The [external manifest](dataset/external-sources/manifest.json) and each source JSON preserve the pinned publisher commit, section, canonical URL, extraction spans, normalized text hashes, license evidence and attribution. The cited pre-2026 repository revisions use CC BY 4.0. Current live pages may carry a different license notice; the historical pinned revision supplies the grant for these particular excerpts. Whitespace and paragraph selection are documented; no substantive paraphrase is represented as a quotation.

This is an engineering-authored held-out campaign, not independent third-party benchmark custody or a random sample of real students. Model construction/reference review supplies hypotheses, not human ground truth.

## What the controls change

| Dimension           | Controlled differences                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 facts/sources    | Supported explanation; local nonessential source-description error; core distortion.                                                           |
| Q2 goal/scope       | Usable coverage; thin secondary treatment; essential-goal loss.                                                                                |
| Q3 explanation      | Linked reasoning; local inferential omission; core explanatory error.                                                                          |
| Q4 assessment       | Independent application; solvable retrieval; incorrect authored key.                                                                           |
| Q5 grading/credit   | Hold a sufficient learner answer constant; vary required/optional grading decisions and credit consequences.                                   |
| Q6 diagnosis/repair | Hold the actual wrong answer constant; vary targeted repair, generic support, invented diagnosis or unsupported claims of completed rehearsal. |

Attack variants preserve their registered poor bases while adding presentation/authority manipulation; premise and exposure attacks preserve their separately registered transformations. Constructor bands are stored outside evaluator-visible packets. A constructor's "middle" hypothesis can legitimately receive 0, 2 or U; disagreement is reported, never repaired after scoring.

Preflight repaired a division-wording ambiguity, references bound to the wrong task surface, and shared goal arrays that duplicated Q2 goals and invalidated eight recorded hashes. All 108 constructed inputs were rechecked before final scoring. These were fixture repairs; StudyEval semantics were not retuned. Original rejected fixtures remain private historical diagnostics.

## Interim public subset

The [machine-readable coverage record](dataset/coverage.json) distinguishes the whole population from public originals. The source-family embargo leaves **51 exact inputs**: 12 controlled, 2 boundary and 37 natural cases, with 55 observations / 71 dimension rows including repeats. Six source roots are public: the two deeper original sources on linear constraints/classification and all four external books. The public source set includes the unsuccessful central-tendency course; release was not selected by success or score.

All 24 adversarial inputs belong to source families represented in the active human study. Their **construction recipe, complete anonymous outcomes and family counts are public**, while their exact payloads and related controls are embargoed. The same rule withholds 158 total case inputs and 224 observations. This is an explicit temporary limitation on full input-level reproduction; it is not described as the complete original corpus being public.

In [public-cases.json](dataset/public-cases.json), `caseId` joins the complete anonymous result table; `frozenCaseId` names a published original. `file`, `sha256`, `inputHash`, `dimensions`, `collection`, and `observations` connect input bytes to the saved outcomes. Hidden rows have no such join, source ID, text, reason, or individual input hash. Anonymous triplet IDs retain within-triplet dependence for recomputation. Their private mapping is committed by a SHA-256 receipt and will be reviewed after human completion.

The public subset is not a new benchmark and has no separately promoted headline score. All reported final-machine headline metrics use the complete frozen population and the stated primary/repeat denominators.
