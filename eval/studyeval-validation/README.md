# StudyEval v2.0: Fresh Validation and Reserved Human Alignment

This package preserves the completed post-freeze validation of [StudyEval v2.0](../studyeval/METHOD.md), frozen at `64fdbc4d5fdcfffc3e10132f5881dec334803b8f`. These observations were collected before Candidate 23. They validate the evaluator; the separate final showcase measures Candidate 23 product journeys.

| Prespecified validation | Result | Population |
| --- | --- | --- |
| Controlled reference levels | 70/72 | 24 new semantic families, three constructed quality levels each |
| Strict quality triplets | 22/24 | Entire family must satisfy 2 > 1 > 0 |
| Ordered pairs | 70/72 | Two ties, no inversions |
| Adversarial defect detection | 18/18 | Six variants each of padding, false authority and instruction injection |
| Boundary expectations | 12/12 | Includes genuine unavailable evidence, blank answers and insufficient support |
| Three-run exact repeat agreement | 12/12 | Twelve inputs selected before scoring, each evaluated three times |
| Reserved two-person consensus | 22/24 | 24 of 34 dimension pairs reached exact human consensus |
| All individual human ratings | 53/68 | All original ratings retained, including disagreement |

Human quadratic weighted kappa is 0.948387. The human comparison covers 27 cases, 34 dimension pairs and 68 original ratings. It is a case-level holdout on previously known source texts, not a source-disjoint human-generalization study. The 24 consensus dimensions must not replace the full 68-rating comparison. These results do not measure learning gains.

All 102 unique fresh inputs and 126 observations are included. The human evaluation contains 81 observations, three passes over all 27 cases. Primary figures use the first pass; repeated observations are not extra independent cases. Constructor reference levels are prespecified analytical hypotheses, not human labels. Authoring and automatic evaluation share the Hy3 model family.

Two controlled discrepancies remain: S008/Q5 and S029/Q4. Two human-consensus discrepancies also remain. See the preserved [fresh discrepancy audit](analysis/fresh-discrepancy-audit.json), [human audit](analysis/HUMAN-AUDIT.md), and complete machine-readable results. No case, reference or inconvenient outcome was replaced.

## Evidence Index

- [Fresh cases](dataset/cases/) and [construction references](dataset/registry.json).
- [Fresh complete rows](fresh/rows.json), [all observations and internal judgments](fresh/observations/), and [request accounting](fresh/physical.jsonl).
- [Human complete rows](human/rows.json), [all human observations](human/observations/), [original normalized ratings](human-reference/normalized.json), and [packet mapping](human-reference/packet-map.json).
- [Fresh metrics](analysis/fresh-metrics.json), [human metrics](analysis/human-alignment.json), and [original source reproduction](analysis/human-source-reproduction.json).
- [Original protocol](origin/PROTOCOL.md), [original freeze](origin/FREEZE.json), and [byte-preserving publication lineage](ORIGIN.json).

Original human answer sheets remain in the repository's [historical human evidence](../final-evaluation/human/). Preserved audit notes and JSON provenance retain original campaign paths. This publication places their active counterparts under `fresh/`, `human/`, and `dataset/cases/`; the portable verifier performs these explicit joins. Full wire bodies remain in the source archive; every input, final observation, internal judgment and receipt ledger is available here.

## Reproduce the Saved Results

From the repository root, with Node 24:

```bash
node eval/studyeval-validation/scripts/verify.mjs
```

This makes no model calls. It verifies every published original byte hash, the frozen evaluator runtime, all 207 input/projection/result joins, every dimension row, and recomputes the headline counts and human kappa. It does not certify the semantic truth of the judgments.

To prepare a separate online reproduction without changing published observations:

```bash
node eval/studyeval-validation/scripts/prepare-reproduction.mjs output/studyeval-reproduction-plan
node eval/studyeval/run.mjs --dataset eval/studyeval-validation/fresh/inputs --schedule output/studyeval-reproduction-plan/schedule.json --holdout output/studyeval-reproduction-plan/human-exclusion.json --out output/studyeval-reproduction-run
```

Configure Hy3 using the server-side environment described in [Setup](../../docs/SETUP.md). The preparation step adapts only dataset paths and excludes human cases; all input hashes, cases and replicate counts remain unchanged. The evaluator refuses an existing output directory. A new run is separate evidence and may differ because the serving model alias and randomness are not immutable.
