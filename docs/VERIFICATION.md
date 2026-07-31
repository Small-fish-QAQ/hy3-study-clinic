# Verification and Reviewer Evidence

This document is the reproducibility and reviewer-evidence companion to the [Hy3 Study Clinic README](../README.md). It separates verification detail from the product overview while keeping every published claim auditable.

## Release lineage

| Purpose | Commit or ref | Meaning |
| --- | --- | --- |
| Real Hy3 evaluation source | `46d34f288d6c619d396ee5f39e12cb33249161da` | The six-operation `eval:hy3` suite ran from this clean worktree. |
| Final submitted release | `c67ac6d5a42295a21197794e5055ef7785df3b0b` | Direct child of the evaluated commit; adds the sanitized evidence, its regression guard, and documentation. |
| Immutable final tag | `issue-4-final` | Annotated tag pointing to `c67ac6d`; it is intentionally not moved by later documentation maintenance. |
| Upstream submission | [Tencent-Hunyuan/Hy3#77](https://github.com/Tencent-Hunyuan/Hy3/pull/77) | Wrapper PR targeting upstream branch `rhinobird2026` and linking the independent repository. |

This post-tag audit improves documentation and reviewer-facing metadata. It does not rewrite the historical evaluation or move the release tag.

## Standard verification

Use Node.js 20 or newer from the repository root:

```bash
npm ci
npm run build
npm run lint
npm test
npm run eval:fake
```

The root commands map to the existing monorepo workspaces:

- `npm run build` runs the shared and server TypeScript builds plus the web TypeScript check and Vite production build.
- `npm run lint` runs ESLint and `prettier --check .`.
- `npm test` first builds the shared package, then runs every workspace Vitest suite.
- Migration and HTTP integration coverage live inside the server Vitest suite; there are no separate commands that must be run to obtain those results.

CI executes `npm ci`, build, lint, and tests on:

- Ubuntu with Node.js 20;
- Ubuntu with Node.js 24; and
- Windows with Node.js 24.

The immutable final tag passed all three jobs in [CI run 30604963718](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/runs/30604963718).

## Verified baseline

The immutable final tag and a fresh 2026-07-31 verification of this post-tag documentation audit produced the same totals:

| Workspace | Test files | Tests | Result |
| --- | ---: | ---: | --- |
| `packages/shared` | 5 | 75 | Passed |
| `apps/server` | 38 | 422 | Passed |
| `apps/web` | 16 | 274 | Passed |
| **Overall** | **59** | **771** | **Passed** |

`npm run eval:fake` passed 31/31 structural checks. It covers provenance, alignment, cross-document blueprint scope, Tutor budgets, misconception transitions, review scheduling, retrieval isolation, prompt-injection defenses, mastery bounds, and database foreign-key integrity.

All automated tests and CI use the fake provider. They never require or contact the real Hy3 API.

## End-to-end smoke workflows

The in-process fake-provider smoke is self-contained:

```bash
npm run build
npm run demo:offline
```

The HTTP scripts require a running fake-provider server in another terminal:

```bash
npm run dev:server
```

Then run:

```bash
npm run demo:http
npm run demo:graph
npm run demo:adaptive
```

The graph and adaptive scripts print IDs that can be checked after a server restart:

```bash
node scripts/smoke-graph.mjs verify <workspaceId> <conceptId>
node scripts/smoke-adaptive.mjs verify <workspaceId> <conceptId> <runId>
```

The restart checks verify persisted documents, active graph data, learner state, accepted plans, canonical alignment, misconception/review state, daily-queue data, and completed Tutor runs.

`demo:http` is a lightweight observational smoke script. It fails on HTTP errors, but some displayed booleans and remediation counts are logs rather than strict assertions. Use the Vitest suite, `eval:fake`, and the graph/adaptive workflows for invariant claims; do not treat `ALL FLOWS OK` by itself as proof that every logged semantic condition passed.

## Migration verification

The server suite contains 19 direct migration tests: six current-schema/idempotence tests and thirteen compatibility tests. They cover:

- applying all 11 migrations and re-running them safely;
- populated v1 -> current migration without deleting source, quiz, grading, mistake, mastery, or history rows;
- honest `unknown` origin for workspaces whose historical creation path cannot be reconstructed;
- populated v3 -> current migration, including the SQLite quiz-table rebuild;
- nullable provider/state-change fields for historical completed attempts, without fabricated backfill;
- foreign-key integrity and re-enablement after table rebuilds;
- all-or-nothing rollback after a forced migration failure; and
- conservative legacy workspace/document deletion behavior.

Route and repository tests add transaction, cascade, cross-workspace isolation, legacy request compatibility, and historical-result degradation coverage.

## Real Hy3 evaluation

The optional real-provider suite is intentionally separate from tests and CI:

```bash
npm run build
HY3_BASE_URL=... HY3_API_KEY=... HY3_MODEL=... npm run eval:hy3
```

On PowerShell, set those values in the environment or a local `.env` before running the command. Missing credentials cause a non-zero exit; there is no fake-provider fallback path.

The raw Markdown/JSON reports are written under ignored `eval/reports/`. They include run provenance and per-operation detail and must not be committed. See [eval/README.md](../eval/README.md) for the schema, metrics, and fail-closed publication rules.

## Published online evidence

The repository publishes a sanitized pair derived from a successful raw report:

- [hy3-online-verification.md](evidence/hy3-online-verification.md), for reviewers;
- [hy3-online-verification.json](evidence/hy3-online-verification.json), for machine-readable sanitized aggregates.

The committed record reports 6/6 successful operations, nine requests, one bounded schema-repair request, 43.6 seconds of provider latency, 4/4 and 3/3 proposed concepts passing exact-quote grounding across two fixture documents, agreement on one comparable alignment decision, agreement on three grading samples, 2/2 truly cross-document assessment items, and a valid first Tutor action.

Publication is fail-closed. `npm run eval:evidence` rejects:

- the wrong suite, a non-`hy3` provider, or any fake fallback;
- missing Git provenance or a dirty evaluation worktree;
- failed, skipped, duplicate, missing, or unknown operations;
- no comparable alignment, no truly cross-document item, or an invalid Tutor first step; and
- any derived JSON/Markdown that triggers the credential, URL-credential, token, or local-path scanner.

The exporter keeps only whitelisted aggregate fields. Per-sample details, prompts, raw model output, credentials, endpoint paths/query strings, and local paths never enter the public record. `publishedEvidence.test.ts` verifies that the Markdown is rendered from the same JSON object and that the committed pair remains provenance-complete and secret-free.

Do not rerun `eval:hy3` during ordinary tests or documentation maintenance. Do not rerun `eval:evidence` merely as a read-only check: it is a publication command and intentionally writes tracked artifacts with a new generation timestamp.

## Media verification

The reviewer assets are:

- seven PNG screenshots, each 2560x1600;
- one H.264 MP4, 1920x1200 at 30 fps;
- no audio stream; and
- duration 113.066667 seconds (1:53.07), below the two-minute Issue #4 limit.

The README captions map the screenshots to PDF provenance, graph evidence, bounded tutoring, assessment/state changes, semantic grading, resolved remediation, and persistent learning progress. The video and screenshots are repository files rather than external embeds, so the tagged release retains them.

## Evidence-to-requirement matrix

| Issue #4 claim | Implementation | Reviewer evidence | Automated evidence |
| --- | --- | --- | --- |
| Hy3 powers production semantic workflows | [`hy3Provider.ts`](../apps/server/src/llm/hy3Provider.ts), [`provider.ts`](../apps/server/src/llm/provider.ts) | [Online verification](evidence/hy3-online-verification.md), [demo](assets/hy3-study-clinic-demo.mp4) | [`hy3Provider.test.ts`](../apps/server/src/llm/hy3Provider.test.ts), [`flows.test.ts`](../apps/server/src/routes/flows.test.ts) |
| Interactive web frontend | [`App.tsx`](../apps/web/src/App.tsx), [`views/`](../apps/web/src/views) | Seven screenshots and the final demo | [`App.test.tsx`](../apps/web/src/App.test.tsx) and focused view/component suites |
| Page/section source provenance | [`documents.ts`](../apps/server/src/ingestion/documents.ts), [`verify.ts`](../apps/server/src/grounding/verify.ts) | [Screenshot 01](assets/01-pdf-page-evidence.png) | [`documents.test.ts`](../apps/server/src/ingestion/documents.test.ts), [`verify.test.ts`](../apps/server/src/grounding/verify.test.ts) |
| Locally validated concept graph | [`graph.ts`](../apps/server/src/services/graph.ts), [`validate.ts`](../apps/server/src/graph/validate.ts) | [Screenshot 02](assets/02-learning-graph-evidence.png) | Graph validator, service, route, and frontend graph suites |
| Bounded graph-grounded Tutor | [`tutor.ts`](../apps/server/src/services/tutor.ts), [`tools.ts`](../apps/server/src/tutor/tools.ts) | [Screenshot 03](assets/03-hy3-graph-tutoring.png) | [`tutor.test.ts`](../apps/server/src/services/tutor.test.ts), [`tools.test.ts`](../apps/server/src/tutor/tools.test.ts) |
| Hybrid deterministic/semantic grading | [`grading.ts`](../apps/server/src/services/grading.ts), [`score.ts`](../apps/server/src/grading/score.ts) | [Screenshots 04](assets/04-assessment-result-overview.png) and [05](assets/05-hy3-rubric-grading.png) | Score, rubric-alignment, flow, and results-view suites |
| Mistake-remediation loop | [`remediation.ts`](../apps/server/src/services/remediation.ts), [`grading.ts`](../apps/server/src/services/grading.ts) | [Screenshot 06](assets/06-remediation-resolved.png) | Flow, remediation, service, and repository tests |
| Persistent learner state | [`database.ts`](../apps/server/src/db/database.ts), [`study.ts`](../apps/server/src/routes/study.ts) | [Screenshot 07](assets/07-learning-progress.png) | Repository, migration, flow, history, misconception, and review tests |
| Reproducible open-source delivery | [`package.json`](../package.json), [`.env.example`](../.env.example), [`ci.yml`](../.github/workflows/ci.yml) | Final Release, tag, PR, and this document | Full offline suite and three-platform CI matrix |

## Honest scope

- The small hand-authored labels and fixtures make the online record an integration check, not a quality benchmark.
- Exact quotation validation proves location, not complete semantic entailment.
- `eval:fake` checks deterministic boundaries and state invariants, not the pedagogical quality of generated content.
- Real-provider latency and output depend on the configured endpoint and model.
- The current automated suite is broad but is not a formal proof of security, psychometric validity, or perfect PDF reconstruction.
