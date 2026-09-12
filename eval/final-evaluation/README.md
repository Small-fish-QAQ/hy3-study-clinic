# Frozen final evaluation · 2026-09-12

**FINAL MACHINE EVALUATION = COMPLETE · BLINDED INDEPENDENT MODEL REVIEW = COMPLETE · GENUINE HUMAN ANNOTATION AND COMPARISON = COMPLETE**

The complete safe Task 1 evidence package is now public: all **209 frozen inputs, 279 observations, 327 dimension rows, 16 source roots**, the unchanged StudyEval method, original model-review CSVs, packet mappings and six human answer-sheet review copies. Machine evidence derives exclusively from `public-export-final-v6`. Human originals were copied and hashed before normalization; identifying document metadata is excluded from public copies.

Read the [results and limitations](../../docs/EVALUATION_RESULTS.md), [human validation and disagreements](../../docs/HUMAN_VALIDATION.md), [method](../../docs/EVALUATION.md), [construction and coverage](CONSTRUCTION.md), and [execution protocol](PROTOCOL.md).

## Review the evidence

| Material                    | Location                                                                                                                                                                               | Public scope                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Dataset inventory           | [coverage.json](dataset/coverage.json), [public-cases.json](dataset/public-cases.json), [final schedule](dataset/final-schedule.json)                                                  | All 209 cases linked to every scheduled observation and original hash.                                                           |
| Original sample inputs      | [constructed cases](dataset/controlled-cases/), [natural cases](dataset/natural-cases/)                                                                                                | 72 controlled, 24 adversarial, 12 boundary and 101 natural product records.                                                      |
| Sources and rights          | [original sources](dataset/sources/), [OpenStax excerpts](dataset/external-sources/manifest.json)                                                                                      | All twelve original Chinese roots and four pinned English textbook roots.                                                        |
| Construction references     | [constructor-reference.json](dataset/constructor-reference.json), [specification](dataset/construction-spec.json), [source scripts](dataset/construction-scripts/)                     | Prescore expectations/rationales, triplets, transformations and original constructor source. Hypotheses, not human ground truth. |
| Complete results            | [original rows](results/complete-rows.json), [original CSV](results/complete-results.csv), [summary](results/machine-summary.json), [interim-ID mapping](results/release-mapping.json) | All 327 original dimension rows and their anonymous-table joins; 239 primary judgments.                                          |
| Saved judge evidence        | [observations](results/observations/)                                                                                                                                                  | All 279 original structured observations, including invalids and repeat changes.                                                 |
| Product availability        | [course table](results/course-availability.json), [missing opportunities](results/natural-missing.json), [full frozen audit](results/final-product-audit.json)                         | All 20 courses, all 79 unavailable sample opportunities and recorded Formal consequences.                                        |
| Cost and latency            | [call-accounting.json](results/call-accounting.json)                                                                                                                                   | 847 evaluator and 380 product terminal receipts, with usage and unknowns; no prompts, headers or content linkage.                |
| Independent model reviews   | [original CSVs and provenance](human/model-reviews/), [joint counts](results/model-review.json)                                                                                        | All 34 primary judgments by Max/Fable and all 74 saved StudyEval packet rows (34 primary + 40 repeats).                          |
| Human validation            | [six review copies](human/review-copies/), [original hashes](human/original-hashes.json), [normalized answers](human/normalized.json), [comparison tables](human/comparisons.json)     | 68 original scores/reasons, optional metadata retained as not provided, exact-consensus and all-ratings comparisons.             |
| Blinded materials and joins | [original packets](human/packets/), [packet map](human/packet-map.json), [item comparisons](human/item-comparisons.json)                                                               | Original input identity, assigned human pair, exact model/human scores and model ambiguity flags.                                |
| Frozen evaluator            | [method/src](method/src/), [original freeze](method/original-freeze.json)                                                                                                              | All eight original StudyEval v1.5 modules, byte-for-byte.                                                                        |
| Identities and custody      | [frozen receipts](results/frozen-receipts.json), [final custody](results/final-publication-custody.json), [release manifest](MANIFEST.json)                                            | Original product, method, schedule/export identities and exact copied-file hashes; historical interim IDs are retained.          |

## Reproduce the published statistics

From the repository root, with Node.js 20.9+ (validated locally on Node 24) and Python 3:

```bash
node eval/final-evaluation/scripts/verify-publication.mjs
python eval/final-evaluation/scripts/verify-human.py
```

Both commands use standard libraries only, require no credentials, database, server or network, and leave the evidence unchanged. The Node verifier checks all input/observation joins, the original method and schedule identities, original-vs-anonymous row equivalence, and recomputes machine metrics, full-corpus length baseline, course availability and cost/latency. The Python verifier parses the six public DOCX review copies afresh, checks their exact score/reason cells against normalized exports, verifies source model CSVs against packet mappings and frozen observations, and recomputes every human/model comparison and ambiguity overlap. Neither executes StudyEval or a model.

The two human scores must be equal and numeric to form consensus; 24/34 dimensions meet that definition. Ten remain unresolved. The complete 68-rating comparisons are published alongside that conditional subset. U, explicit abstention, missing answers and invalid model outputs are separate categories. Editorial disagreement analysis never overwrites source labels.

Reproduction limits: the already completed network-disabled 279-observation raw-response replay is a **recorded prior audit**. Its receipt is published; raw wire bodies, private SQLite databases and identifying metadata from human originals remain private. The public checks validate saved evidence and recompute its statistics, not provider inference or the private raw-wire replay. Original constructor scripts are archived as `.txt` for inspection; any reconstruction should use a disposable directory, and generated files must be compared against the frozen inputs rather than replacing them.

## Release history and privacy

The interim release exposed 51 cases and withheld complete source families to protect the active human study. After all six returned originals were frozen, that temporary restriction was lifted; all 158 previously withheld cases and 224 observations, original IDs and model-review opinions are now public. The existing anonymous IDs remain usable through the published mapping whose hash was committed in the interim receipt.

Original human DOCX files are preserved privately and separately from normalized exports because five contain a personal email in hidden revision properties. Public review copies strip metadata while preserving the original `word/document.xml` and all answer/layout content bytes. Raw original file hashes, public-copy hashes and document XML hashes distinguish these identities. All six start/end time fields and procedure/help notes were left blank; no timing, absence of help or verified blinding is inferred. Reviewers can inspect the score/reason contents and normalization directly.

Original project-authored material uses the repository's Apache-2.0 license. OpenStax excerpts retain their separately documented CC BY 4.0 attribution and pinned-revision license evidence; that material is not relicensed by the project.
