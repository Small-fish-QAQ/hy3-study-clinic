# StudyEval: evidence-based ordinal evaluation

StudyEval evaluates learning artifacts across six dimensions: evidence and truth (Q1), declared coverage/depth (Q2), explanation (Q3), assessment validity/discrimination (Q4), grading/credit (Q5), and diagnosis/repair (Q6). It returns a dimension profile rather than an arbitrary weighted total.

The exact operational anchors are in `rubric.mjs`. A **2** means the requested requirements are supported without a demonstrated defect. A **1** requires a concrete local defect that leaves the core use intact. A **0** requires a material defect that changes the core conclusion, mechanism, grading decision or learning use. **U** is for genuinely unavailable evidence needed to decide the dimension. Visible missing content is an observable quality defect; evaluator formatting failures are separately recorded as **JUDGE_INVALID**.

## Judgment procedure

1. Project only the supplied evidence and requested dimensions. Benchmark IDs, expected levels, constructor explanations, prior results and human labels are excluded from model input.
2. Where assessment/grading requires it, solve the question without author keys, student responses or product grading. For referenced prior scenarios, first extract verbatim scenario facts without solutions. For grading, separately analyze the student's entire answer against each criterion without seeing product judgments or feedback.
3. Obtain two separate artifact reviews. Neither sees the other's score. Both see original evidence and the prior blind task/student analysis, which is advisory and can be challenged from the original evidence. For Q2, separately map each goal to actual artifact evidence, distinguishing usable, partial, merely mentioned, missing and contradicted coverage. This auxiliary map is withheld from both independent reviews to avoid propagating a shared mistaken premise; only adjudication receives it.
4. Adjudicate disagreements, unresolved judgments, disagreements with the blind student analysis, and every proposed non-perfect judgment. For each alleged defect, quote and inspect original evidence that could uphold or refute it. Reviewers can agree on a false accusation; agreement alone does not establish truth.
   Each proposed U also receives a separate availability check: the needed evidence is available, outside the actual task requirements, or still unavailable. The check cites original evidence. Refuting a penalty does not establish the missing support; a remaining decisive gap permits U or an independently established material zero. It cannot certify a positive score. A product's obligation to attach records and an evaluator's ability to verify external facts are separate questions.
5. Validate JSON structure, actual evidence pointers and quotes, ordinal/severity consistency, and the correspondence between explicit assessment/grading checks and the final level. These are structural and logical checks, **not deterministic proof of semantic truth**. A local defect in a field does not erase supported material elsewhere in that same field.

Each question can sample a relevant skill. A local explanation need not cover a complete course. A next repair question may change surface details while checking the same reasoning error. A hidden author key is still part of the assessment being evaluated: an incorrect key is not excused merely because it was not disclosed to the learner.

A correct explanation can give the key reasoning operation and its objects without spelling out every arithmetic step that the stated prerequisites cover. Correct boundary conditions do not automatically require a second worked example. Conversely, a false boundary that changes valid solutions, permitted inferences or applicability is material when it is part of the declared teaching purpose; a correct main example does not excuse it. Material findings trigger a review of related requested dimensions based on their actual dependency, without mechanically spreading a score or U across an entire field.

## Reproduction

Use Node.js 24 and the repository's installed dependencies. Supply Hy3 credentials through `HY3_BASE_URL`, `HY3_MODEL`, `HY3_API_KEY`, or the repository's existing local provider configuration. Credentials are never placed in captured requests or results.

```powershell
node eval/studyeval/run.mjs --dataset C:/path/to/development --schedule C:/path/to/development/schedule.json --holdout C:/private/reserved-holdout.json --out C:/path/to/new-run
node --test eval/studyeval/test/*.test.mjs
```

The private holdout manifest must provide `excludedCaseIds` and `excludedInputHashes`; it may also provide `excludedCasePatterns`. A schedule contains `caseId`, `runId`, `replicate`, a relative case `path`, and `inputHash` (SHA-256 of the exact parsed record serialized with `JSON.stringify`). The runner rejects a reserved identity before reading its case, checks input hashes before requests, and requires a new output directory. Its identity file is written before inference. The manifest is a development exclusion rule, not an option to run the human holdout.

For grading inputs, an absent or null `evidence.answer` means the student's response is unavailable. A supplied string is the visible submission, including an empty or whitespace-only string, unless explicitly marked as redacted or incomplete. The evaluator grades the product's decision: correctly withholding credit for an empty submission can earn 2; falsely granting required credit is a material grading error. The blind task solver's intentionally restricted view cannot establish that the student answer is missing from the full record.

When `productJudgment.consequence` explicitly records granted or withheld credit, certification copies that observed value with its evidence witness and compares it to the model's warranted-credit judgment. Uncertainty about the student's hidden response does not erase a known product action. This copies an input fact; it does not determine what credit the student deserves or change a proposed score.

Outputs include per-observation JSON, CSV/JSON dimension rows, each stage's input and parsed result, full request/response wire captures, and a physical request ledger with provider identity, latency, completion status and token usage. `prompts.mjs` is authoritative for model parameters, retries and maximum output size. Requests are paced below the observed provider limit, with cooldown and bounded retries for rate limits. Run one campaign at a time per provider quota.

Format repair must preserve established semantic decisions. A mechanical reference repair can remove a `/view` wrapper, bind a quotation on a text-unit container to its exact `.text` field, or discard a reference that does not resolve to original evidence; every change is recorded, and all required valid witnesses must still remain. It cannot invent evidence or change a score. An empty verification list may be omitted when there are no proposed defects. Actual defect obligations remain mandatory. Unusable syntax/shape or truncation triggers a bounded fresh inference, with every attempt retained. No valid score is discarded to shop for a preferred result. Plain JSON output is requested without the provider JSON-object mode, which produced corrupt escaped field names during calibration.

## Scope and limitations

Structured missing-evidence entries containing up to four nonempty string fields can be normalized to JSON text while retaining every key and character. This lossless conversion preserves the semantic fingerprint, including the reason for uncertainty. No field is dropped, summarized or inferred, and the original representation and conversion receipt remain saved.

An unavailable-field claim can cite its actual parent container and the absent key. The empty JSON Pointer refers to the complete input view. Certification checks that the parent exists and the key is actually absent; an existing empty string or null value cannot pass this absence check. A null quotation pointing to a missing child in an unavailability check can be mechanically rebound to this verified parent/key witness, with its original pointer and repair receipt retained. This does not infer whether the absent evidence is necessary or change the model's score.

This is an evaluator for supplied artifacts, not a claim about actual learning gains. Constructor labels are development hypotheses, not human truth. Mutable provider model aliases and serving nondeterminism limit bit-for-bit online reproducibility; recorded raw outputs support deterministic replay. Review and adjudication calls use the same Hy3 model, so their errors can be correlated. Quoting source text improves traceability but cannot establish entailment on its own. Real evidence gaps must remain U, and exhausted transport/output failures remain visible as INVALID.

The historical v1.5 campaign under `eval/final-evaluation` is preserved. Championship calibration and its authoritative development report are recorded separately; the human-validated reserved holdout has not been used for this calibration and awaits a separate post-freeze review step.
