# Candidate 23: Final 20-Course Product Showcase

**15/20 complete first-checkpoint journeys; 15/20 courses with supported, applied evidence.** All 20 frozen cases remain in the denominator. This is a synthetic product delivery showcase on complete intended-use materials, not a human learning-success rate or a full-course completion rate.

Reviewer-facing product demonstration quality was an explicit design objective. Before freeze, the constructor studied the most stable old development materials and successful actual journeys, then authored new self-contained notes with comparable density, explanation, examples and ordinary application depth. There are no deliberately damaged, incomplete or adversarial source courses in the main denominator. Read the [design rationale](DESIGN.md), [historical review](dataset/historical-design-review.json), [source audit](dataset/source-audit.json) and [preregistered protocol](PROTOCOL.md).

## Complete Results

| Stage | All frozen courses |
| --- | --- |
| Material imported | 20/20 |
| Route prepared | 20/20 |
| Lesson / Practice available | 18/20 |
| At least one teaching activity complete | 17/20 |
| All attempted teaching complete | 17/20 |
| Formal attempted | 17/20 |
| Formal candidate returned | 17/20 |
| Formal admitted | 15/20 |
| Answer submitted | 15/20 |
| Supported evidence recorded | 15/20 |
| Durable applied credit | 15/20 |
| Complete first-checkpoint journey | 15/20 |

Teaching activities: 33/36 completed. The protocol stops after the first Formal submission, with at most four teaching activities and one explicit preparation retry when offered. Most first checkpoints test a constituent concept or near application; they do not establish every source goal or deep transfer.

The task assistant reviewed every credited primary answer, private key and required rubric. **12/20** mechanically complete journeys had no identified material task/answer defect in that review. There are 3 credited task caveats and 2 credited answer caveats; these may concern the same courses and must not be added as independent cases. This is not independent human validation, and delivered Lesson content was spot-checked rather than fully certified.

Every course and reason is in [the complete table](analysis/scored-01/RESULTS.md), [CSV](analysis/scored-01/complete-results.csv), [mechanical results](analysis/scored-01/results.json) and [content audit](analysis/scored-01/content-audit.json). No outcome was replaced, the product was not tuned, and no favorable rerun was selected. [Representative examples](EXAMPLES.md) are labeled excerpts, not the denominator.

## Evidence Integrity

- Isolated answer controls: 0/30 submitted controls received durable credit; 10 of 40 scheduled control opportunities were not submitted. Unreached controls are not counted as successful rejections.
- Cold persistence/integrity: 50/50 databases; 5950 table comparisons.
- Source/scoring/premise bindings: 45/45.
- Identical primary submission replays: 15/15, with zero new calls or table changes for passed replays.
- After-teaching snapshots with zero Formal evidence: 33/33.

[Runtime audit](analysis/scored-01/runtime-audit.json) retains every error, if present. These checks establish saved-state and custody properties, not universal semantic truth. No control branch changes the main learner journey.

Provider receipts record 659 requests, 659 completed responses and 5,012,902 total usage tokens, including learner and control calls. Transport failures: 0; HTTP errors: 0; missing usage: 0. Token usage is not an actual billed-currency claim.

## Freeze and Reproduction

Product commit: `84b3c2fbce7e6523e43a8fa66df42bb6e37fa149`. All 20 sources, goals, depths, controls, learner policy, driver, analysis metrics and design/protocol files were frozen at `2026-09-14T11:13:52.154Z`, before the first scored request. Freeze SHA-256: `4c99f3a1e5a547cc80a565516da743a1d9a66de06b77f18a1240e6805981a915`. Six course workers used the same frozen model/endpoint identity. The provider's immutable weights cannot be independently verified.

From the repository root, with Node 24, verify saved results without model calls:

```bash
node eval/final-showcase/publication/verify.mjs
```

The verifier hashes every published original file, verifies the source/protocol freeze, and independently derives the complete funnel and evidence outcomes from all terminal snapshots and state records. [ORIGIN.json](ORIGIN.json) identifies every byte-preserved file. The repository includes terminal primary/control snapshots, accepted teaching surfaces, visible learner packets, Formal records, original result ledgers and analyses. Full SQLite databases, wire bodies and the exact source/compiled runtime are in the release's [final-showcase-audit.zip](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/download/task1-final-2026-09-14/final-showcase-audit.zip), with its own complete manifest and [download hash](publication/ARCHIVE.json).

To repeat the original cold database/binding audit, extract that archive, install the repository dependencies with `npm ci`, and run the frozen analyzer on the archived campaign with `STUDY_CLINIC_ROOT` set to the Candidate 23 product checkout. The preparation helper validates every archive hash and restores the exact compiled runtime while requiring unchanged Candidate 23 sources:

```powershell
$env:STUDY_CLINIC_ROOT = (Get-Location).Path
node eval/final-showcase/publication/prepare-reproduction.mjs C:/path/to/extracted-final-showcase-audit
node C:/path/to/extracted-final-showcase-audit/campaign/scripts/analyze.mjs scored-01
```

The analyzer regenerates derived analysis files from saved databases; archive originals remain available in the ZIP. For a separate paid online reproduction, configure `HY3_BASE_URL`, `HY3_MODEL` and `HY3_API_KEY` to the frozen provider identity, then run `node eval/final-showcase/scripts/run.mjs reproduction-01`. It refuses existing outputs and verifies all frozen source/runtime hashes. Do not rerun the dataset builder or rewrite the freeze. Historical construction scripts require the private development corpus; published frozen inputs and hashes are the reproduction authority. New online outcomes may differ and are not part of the submitted score.

## Interpretation

All sources are original teaching notes, 16 Chinese and four English, with four basic and 16 working-depth requests. This favorable distribution follows intended normal use; it does not estimate performance on arbitrary uploads, missing context, OCR failures or external textbooks. Shared-model synthetic learning and review can have correlated errors. Source correctness/freshness and post-score content reviews are by the task assistant. No human learning gains, long-term mastery, full accessibility or deployment-readiness claim is made.

The separate [StudyEval v2 validation](../studyeval-validation/README.md) was collected after evaluator freeze and before Candidate 23. Its 207 observations and reserved human alignment are not scores for these 20 product courses. [September 12 historical evidence](../final-evaluation/README.md) remains unchanged.
