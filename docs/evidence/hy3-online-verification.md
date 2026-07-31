# Hy3 Study Clinic — Real Hy3 Online Verification

> Sanitized public record of the real-provider evaluation (`eval:hy3`) executed online
> against the Hy3 API at the source commit below. Derived from the gitignored raw report
> by `eval/export-evidence.mjs`; the raw report itself is never committed.

## Run identity

| Field | Value |
| --- | --- |
| Overall result | **passed** (6/6 operations) |
| Provider | `hy3` (real online API) |
| Fake fallback | `false` — eval/run-hy3.mjs exits non-zero when HY3_BASE_URL, HY3_API_KEY, or HY3_MODEL is missing. The script has no FakeProvider code path and cannot silently fall back. |
| Model | `hy3` |
| Endpoint host | `tokenhub.tencentmaas.com` |
| Source commit | `46d34f288d6c619d396ee5f39e12cb33249161da` |
| Branch / worktree | `main` / clean |
| Executed at (UTC) | 2026-07-31T04:28:21.661Z |
| Evidence generated at (UTC) | 2026-07-31T04:32:32.265Z |
| Runtime | Node.js v24.14.1 on win32 |
| Requests | 9 total, 1 bounded repair call, provider latency 43.6s |

## Operations

| Operation | Result | Requests | Bounded repairs | Latency | Key metrics |
| --- | --- | ---: | ---: | ---: | --- |
| `concept_analysis` | ✅ passed | 1 | 0 | 4.8s | proposed=4, groundingAccepted=4, groundingAcceptanceRate=1, firstPassSchema=true |
| `concept_analysis_doc_b` | ✅ passed | 1 | 0 | 4.0s | proposed=3, groundingAccepted=3 |
| `alignment_agreement` | ✅ passed | 1 | 0 | 1.8s | comparablePairs=1, agreement=1, agreementRate=1 |
| `grading_agreement` | ✅ passed | 3 | 0 | 6.9s | samples=3, correctnessAgreement=1, keyPointExactMatch=1 |
| `cross_document_assessment` | ✅ passed | 2 | 1 | 23.8s | items=2, itemsWithVerifiedPrimaryEvidence=2, itemsTrulyCrossDocument=2 |
| `tutor_first_step` | ✅ passed | 1 | 0 | 2.2s | action=call_tool, tool=inspect_learning_state |

## What this proves

- The exact source version above completed every model-backed evaluation operation against the real Hy3 endpoint, with structured output accepted by runtime schema validation (at most one bounded repair per call).
- Proposed evidence quotes were verified by the local exact-quote grounding validator against the real source blocks.
- Alignment and short-answer grading agreed with the small hand-authored labels at the rates recorded above, and the cross-document operation produced at least one question whose verified evidence really spans multiple documents.
- The Tutor first step stayed inside the controlled action vocabulary.

## What this does not prove

- The sample is deliberately small (original fixtures and hand-authored labels; counts are shown in the operation metrics). Results are indicative, not a benchmark, and depend on the configured model and API.
- Alignment agreement includes only labelled pairs whose concept names were extracted in this run (comparablePairs); unmatched labelled pairs are outside the denominator.
- This record proves that cited text exists at the claimed source position and passed local structural validation. Exact quotation verification does not independently prove complete semantic entailment.
- The raw report under eval/reports/ is gitignored. This record is a sanitized derivation that publishes only the endpoint hostname; credentials and local paths are never included.

## Reproduce

```bash
npm run build
npm run eval:hy3   # requires your own real HY3_* credentials; missing values fail closed
npm run eval:evidence
```

The complete sanitized aggregates are in `hy3-online-verification.json` in this directory; both files are generated from the same validated object.
