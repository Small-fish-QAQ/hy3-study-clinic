# Frozen final evaluation · 2026-09-12

**FINAL MACHINE EVALUATION = COMPLETE · BLINDED INDEPENDENT MODEL REVIEW = COMPLETE · GENUINE HUMAN VALIDATION = IN PROGRESS**

This interim release derives exclusively from `public-export-final-v6`. It contains the complete anonymous machine result table and a source-disjoint subset of the exact frozen inputs and observations. The full input corpus remains under a temporary human-study embargo. This is not yet the complete public input release.

Read the [results and limitations](../../docs/EVALUATION_RESULTS.md), [method](../../docs/EVALUATION.md), [construction and coverage](CONSTRUCTION.md), and [execution protocol](PROTOCOL.md).

## Review the evidence

| Material                  | Location                                                                                                                                         | Public scope                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset inventory         | [coverage.json](dataset/coverage.json), [public-cases.json](dataset/public-cases.json)                                                           | 209 frozen cases overall; 51 exact cases publicly linked to results.                                                                   |
| Original sample inputs    | [controlled cases](dataset/controlled-cases/), [natural cases](dataset/natural-cases/)                                                           | 12 controls, 2 boundary cases, 37 natural records; selected solely by absence of human-study source-family overlap.                    |
| Sources and rights        | [original sources](dataset/sources/), [OpenStax excerpts](dataset/external-sources/manifest.json)                                                | Two original Chinese roots and four pinned English textbook roots, including one with no generated natural record.                     |
| Complete results          | [JSON rows](results/machine-rows.json), [CSV rows](results/machine-rows.csv), [summary](results/machine-summary.json)                            | All 279 observation runs / 327 dimension rows; 239 primary dimension judgments. Embargoed rows have opaque IDs and no content mapping. |
| Saved judge evidence      | [observations](results/observations/)                                                                                                            | 55 complete structured observations linked to the 51 public cases; 71 dimension rows including repeats.                                |
| Product availability      | [course table](results/course-availability.json), [missing opportunities](results/natural-missing.json), [summary](results/product-summary.json) | All 20 courses and all 79 unavailable natural sample opportunities; content and source identities withheld where needed.               |
| Cost and latency          | [call-accounting.json](results/call-accounting.json)                                                                                             | 847 evaluator and 380 product terminal receipts, with usage and unknowns; no prompts, headers or content linkage.                      |
| Independent model reviews | [model-review.json](results/model-review.json)                                                                                                   | Joint counts for 34 primary judgments, source-file hashes and comparison statistics; no item IDs or individual answers.                |
| Frozen evaluator          | [method/src](method/src/), [original freeze](method/original-freeze.json)                                                                        | All eight original StudyEval v1.5 modules, byte-for-byte.                                                                              |
| Identities and custody    | [frozen receipts](results/frozen-receipts.json), [release manifest](MANIFEST.json)                                                               | Original product, method, schedule and export identities; every published file has a byte hash.                                        |

## Reproduce the published statistics

From the repository root, with Node.js 20.9+ (validated locally on Node 24):

```bash
node eval/final-evaluation/scripts/verify-publication.mjs
```

This command needs no dependencies, credentials, database, server or network. It reads saved results, checks the manifest and original method hashes, checks every public input against its saved observation, and independently recalculates counts, controlled discrimination, repeated-score consistency, adversarial results, product availability, cost/latency, and model-comparison arithmetic. It does not execute StudyEval or call a model.

Three reproducibility boundaries matter:

- The complete anonymous row statistics can be recalculated now. The 51 public inputs can also be inspected against their original structured judge observations.
- Model comparison can be recalculated from published joint counts. The individual model reviews and their item mapping remain sealed, so independent rechecking of that extraction awaits human completion. The recorded length baseline is also a frozen full-corpus summary; embargoed text lengths are not disclosed as possible fingerprints.
- The already completed, network-disabled 279-observation replay is a **recorded prior audit**. Its receipt is published; raw provider wire bodies, private databases and the campaign transport/driver are not included. This public command is saved-evidence verification, not a repeat of that raw-wire replay or a fresh Hy3 experiment.

## Embargo and provenance

The three ongoing human packets cover 27 items / 34 requested dimensions. To prevent answer lookup through related cases, this release withholds all input/output text and content-linked labels for **every source family represented in those packets**, including sibling controls, attacks, natural outputs and repeats. The release publishes neither packet membership nor the anonymous-to-original mapping for those rows. Aggregate model opinions are not human labels.

After genuine human responses are frozen, one small publication pass remains: integrate their provenance and agreement, resolve/report disagreements without changing frozen machine outcomes, and release the privacy-reviewed remaining inputs and mappings. Genuine human answer sheets and personal information are not intended for public release.

Original project-authored material uses the repository's Apache-2.0 license. OpenStax excerpts retain their separately documented CC BY 4.0 attribution and pinned-revision license evidence; that material is not relicensed by the project.
