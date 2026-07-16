# Hy3 Study Clinic

[![CI](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml/badge.svg)](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Hy3 Study Clinic is a traceable study workflow built around **learning material → grounded concept analysis → quiz generation → hybrid grading → mistake remediation → historical weighted mastery**. Generated concepts, questions, explanations, and remediation exercises carry citations to exact quotations in source blocks, and the server verifies the location of every accepted quotation.

## Demo

https://github.com/user-attachments/assets/13acc199-9212-433b-bee3-802a8e90a854

**[Watch the full demo video (under 2 minutes)](docs/assets/hy3-study-clinic-demo.mp4)**

Verified locally: **1:38.834**. The walkthrough covers both end-to-end learning workflows, evidence panels, hybrid grading, remediation, resolved mistakes, and historical weighted mastery. Material history management is documented in the accompanying screenshots.

## Core workflows

### Flow A — Grounded quiz and grading

1. Load the built-in sample, paste text, or import a `.md` or `.txt` learning material.
2. Local ingestion validates and splits the material into stable source blocks.
3. Hy3 analyzes core concepts and returns a quotation plus source-block reference for each one.
4. Hy3 generates questions, explanations, and exact-quote citations from the material.
5. Single- and multiple-choice questions are graded deterministically; nonblank short answers use Hy3 semantic rubric grading.
6. The result view shows scores, answer explanations, grading provenance, rubric feedback, and traceable source evidence.

### Flow B — Mistake remediation

1. An answer scoring below `0.6` enters the mistake book as an open mistake.
2. Only concepts with **currently open** mistakes are eligible. They are ordered deterministically by open-mistake count, with at most three concepts selected per round.
3. Hy3 generates exactly one single-choice question and one short-answer question for every selected concept, so a remediation quiz always contains **2–6 questions**.
4. Resolved concepts are excluded, even if their historical mastery remains low.
5. A correctly answered remediation question resolves exactly its linked source mistakes; a low-scoring remediation answer can create a new open mistake.
6. Local code updates historical weighted mastery from the graded concept score. The model does not choose the update formula.

When there are no open mistakes, the server refuses remediation generation and the UI disables the action with an explicit empty state.

## Evidence

The screenshots are grouped by what they verify. They show the Chinese-language UI used in the final demo.

### Grounded quiz and grading

![Grounded concept analysis with source evidence](docs/assets/01-hy3-grounded-analysis.png)

_Grounded concept analysis with source evidence — each visible concept includes an exact quotation and a source-block reference._

![Generated quiz with traceable evidence](docs/assets/02-hy3-generated-quiz.png)

_Generated quiz with traceable evidence — questions expose their cited source passage without exposing answer keys before submission._

![Deterministic objective grading plus Hy3 semantic grading](docs/assets/03-hy3-grading-result.png)

_Deterministic objective grading plus Hy3 semantic grading — the result view labels grading provenance and shows explanations and evidence._

### Mistake remediation and mastery

![Remediation generated from an unresolved concept](docs/assets/04-hy3-remediation-quiz.png)

_Remediation generated from an unresolved concept — the quiz is explicitly scoped to the learner's open mistake concepts._

![Rubric points, feedback, confidence, and source evidence](docs/assets/06-hy3-semantic-grading.png)

_Hy3 semantic grading — visible rubric points, feedback, confidence, and source evidence make the short-answer judgment reviewable._

![Resolved mistake and no-open-mistakes state](docs/assets/07-hy3-mistakes-resolved.png)

_Resolved mistake and no-open-mistakes state — the mistake is marked resolved and remediation generation is disabled._

![Recent score versus historical weighted mastery](docs/assets/08-hy3-mastery.png)

_Recent score versus historical weighted mastery — the UI keeps the latest result separate from the deterministic historical estimate._

### Material history

![Searchable material history with management actions](docs/assets/09-material-history-management.png)

_Searchable material history — persisted records provide open, rename, and permanent-delete actions._

Additional evidence: [successful 100-point remediation result](docs/assets/05-hy3-remediation-result.png).

## What Hy3 does

The real `hy3` provider implements four model-backed tasks through an OpenAI-compatible `chat/completions` API:

- extract concepts with proposed `{ blockId, quote }` evidence;
- generate grounded standard quiz questions and explanations;
- generate grounded remediation questions for selected open-mistake concepts;
- semantically grade nonblank short answers against rubric points, returning a normalized score, matched points, confidence, and feedback.

Source blocks are wrapped in fresh per-request delimiters, labelled with stable block IDs, and explicitly marked as untrusted data rather than instructions. Short-answer grading inputs are fenced in the same way. Model output is JSON-extracted and checked against runtime schemas. If the model content cannot be extracted as valid JSON or fails its schema, the provider makes **one** structured repair request; a second failure returns a structured error. Transport, timeout, and later grounding failures are not retried by that repair loop.

After schema validation, the server checks every proposed citation using exact string matching. It computes offsets itself, records repeated occurrences, narrowly re-anchors a quote only when there is one unambiguous alternative block, and rejects unsafe or missing evidence. This verifies that the cited text exists at the recorded location; it does not independently prove the semantic truth of every generated explanation.

Hy3 does **not** perform objective scoring, total-score arithmetic, remediation target selection, mistake lifecycle management, mastery math, or SQLite persistence.

## What remains deterministic and local

The application keeps control-flow and record-keeping decisions outside the model:

| Local responsibility | Behavior |
| --- | --- |
| Ingestion and segmentation | Normalizes text, rejects unsupported/binary/oversized inputs, and creates source blocks with stable offsets. |
| Runtime and grounding validation | Enforces request/domain schemas, question-type-specific fields, known concepts, requested question types, and exact-quote grounding. |
| Objective grading | Single choice uses exact equality; multiple choice uses exact set equality with no partial credit. Blank short answers receive a deterministic zero. |
| Score calculation | Maps normalized question scores to points and totals all awarded/possible points locally. |
| Mistake lifecycle | Creates open mistakes below the `0.6` threshold and resolves the exact source mistakes linked to a correct remediation answer. |
| Remediation scope | Selects up to three open-mistake concepts and enforces exactly one single-choice plus one short-answer question per concept. |
| Persistence and recovery | Stores records in SQLite; restores the last selected material, its blocks and concepts, while keeping mistake and mastery records available through material-scoped APIs. |
| Material management | Searches history, renames records, and transactionally deletes a material and its related learning records. |
| Request safety | Propagates cancellation and ignores superseded or late UI responses, including responses for a material that was switched or deleted. |

Historical weighted mastery uses the transparent local formula:

```text
m' = clamp01(m + 0.3 × (score − m))
```

Each concept starts at `0.5`. For a submission, the local service averages that concept's question scores and applies one update. A first perfect concept score therefore moves mastery to `0.65`, not `1.0`. This is a deterministic historical estimate—not a scientific cognitive diagnosis—and short-answer scores supplied to the formula can originate from Hy3's semantic grading.

## Architecture

```text
apps/web (React + Vite)
        │  /api JSON
        ▼
apps/server (Fastify)
        ├── ingestion + grounding + deterministic services
        ├── SQLite (better-sqlite3)
        └── provider boundary ──► Hy3-compatible API or offline Fake Provider

packages/shared ── runtime Zod schemas, domain types, provider payloads,
                   sample material, and mastery formula used by both apps
```

- [`apps/web`](apps/web) contains the interactive import, quiz, results, mistake, mastery, evidence, and history-management UI.
- [`apps/server`](apps/server) contains Fastify routes, ingestion, grounding verification, grading/remediation services, provider adapters, repositories, and migrations.
- [`packages/shared`](packages/shared) contains the cross-workspace runtime schemas and deterministic domain utilities.
- SQLite stores materials, blocks, concepts, quizzes, submissions, grading results, mistakes, and mastery. The browser talks only to the server; it never calls Hy3 directly.

For a deeper request-lifecycle description, see [Architecture & Design Notes](docs/ARCHITECTURE.md).

## Getting started

### Requirements and installation

- Node.js **20 or newer** (`package.json` specifies `>=20.0.0`; `.nvmrc` selects 20).
- npm. Docker and an API key are not required for the default offline mode.

Install dependencies and copy the tracked environment template.

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Unix-like shells:

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:5173>. The Vite development server proxies `/api` to the Fastify server at `http://127.0.0.1:8787`.

### Provider modes

- `LLM_PROVIDER=fake` is the default: deterministic, offline, reproducible, and suitable for local development and automated tests. It needs no API key.
- `LLM_PROVIDER=hy3` runs the real online flow. `HY3_BASE_URL`, `HY3_API_KEY`, and `HY3_MODEL` are then required and remain server-side. The repository intentionally provides no default endpoint, model, or credential.

The tracked [`.env.example`](.env.example) defines the complete configuration contract:

| Variable | Default in the tracked example | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `fake` | Select `fake` or `hy3`. |
| `HY3_BASE_URL` | empty | Hy3-compatible API base URL; the adapter appends `/chat/completions`. Required for `hy3`. |
| `HY3_API_KEY` | empty | Server-side API key. Required for `hy3`; never place a real key in tracked files. |
| `HY3_MODEL` | empty | Provider model name. Required for `hy3`. |
| `HY3_TIMEOUT_MS` | `30000` | Per-call timeout in milliseconds. |
| `PORT` | `8787` | Fastify port. |
| `HOST` | `127.0.0.1` | Fastify bind host. |
| `DATABASE_PATH` | `./data/clinic.sqlite` | SQLite file, or `:memory:` for an ephemeral database. |

`DATABASE_PATH` is resolved from the server process working directory. With the normal npm workspace commands, the default file is `apps/server/data/clinic.sqlite`; if the compiled server is launched from another directory, use an absolute path when location must be independent of the working directory. The root `.env` is loaded explicitly even though the server runs from its workspace.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared code, then run server and web development processes. |
| `npm run build` | Production build/type-check for all workspaces. |
| `npm run start -w @hy3-clinic/server` | Start the built API server after `npm run build`. |
| `npm test` | Build shared code and run every workspace test suite. |
| `npm run lint` | Run ESLint and Prettier checks. |
| `npm run format` | Apply repository formatting. |
| `npm run demo:offline` | Run both flows in-process with the deterministic fake provider after a build. |
| `npm run demo:http` | Drive both flows over HTTP while `npm run dev:server` is running. |

The web production bundle is emitted under `apps/web/dist` and can be served by a static host alongside the API.

## Persistence and material management

Learning records are stored locally in SQLite and remain available after a browser refresh. The browser stores only the last selected material ID in `localStorage`; on startup it verifies that ID against SQLite-backed history, then restores the material, source blocks, and persisted concepts. Mistakes and mastery remain available through their material-scoped APIs.

Recent-material history provides search by title, displayed creation time, or record suffix, plus explicit open, inline rename, and permanent-delete actions. Renaming changes only the trimmed title and preserves the material ID and learning records.

Permanent deletion requires a confirmation that identifies the record and states that the action is irreversible. The root deletion is transactional, and SQLite foreign-key cascades remove the material's blocks, concepts, quizzes, questions, submissions, grading results, mistakes, and mastery records. There is no recycle bin or undo.

## Reliability, privacy, and safety

- Zod runtime schemas validate API inputs, persisted domain objects, and structured provider output; question schemas enforce choice/short-answer-specific required and incompatible fields.
- Exact-quote grounding is verified after model-output validation. Invalid standard questions are discarded, while an incomplete remediation pair fails the whole remediation generation.
- Invalid model JSON/schema output receives at most one repair request, avoiding unbounded retry loops.
- Hy3 calls have configured timeouts and external cancellation that remains active while the response body is read. UI request identities prevent late or superseded responses from replacing current state.
- Transactions protect multi-row operations such as material/block insertion, concept replacement, quiz/question insertion, migrations, remediation counters, and permanent deletion. Foreign keys and cascade behavior are enabled and regression-tested.
- In `fake` mode, provider work stays offline. In `hy3` mode, the source/question context needed for analysis, generation, remediation, and short-answer grading is sent to the configured endpoint; short-answer grading also sends the student's answer and rubric context.
- Credentials are read only by the server, sensitive request headers are redacted from logs, and `.env`, `data/`, SQLite, WAL, and SHM files are ignored by Git.
- Randomized untrusted-data boundaries and plain-text React rendering reduce injection risk, but the project does not claim to be prompt-injection proof.

## Testing

`npm test` was run against the current working tree on **2026-07-16**:

| Workspace | Test files | Tests | Result |
| --- | ---: | ---: | --- |
| `packages/shared` | 3 | 39 | Passed |
| `apps/server` | 17 | 141 | Passed |
| `apps/web` | 2 | 46 | Passed |
| **Overall** | **22** | **226** | **Passed** |

Regression coverage includes exact grounding and source fencing; structured Hy3 output and bounded repair; semantic-grading equivalence rules; deterministic objective grading; resolved-concept exclusion and exact remediation pairs; no-open-mistake behavior; persistence recovery; rename/delete confirmation and failure handling; transactional rollback and cascade deletion; provider timeout/cancellation; and stale-response suppression after navigation, material switching, or deletion.

## CodeBuddy collaboration

CodeBuddy Code was connected to Hy3 through Tencent Cloud TokenHub and used for a focused accessibility and regression audit of the source-evidence disclosure.

- It inspected `SourceEvidencePanel`, its call sites, tests, and shared evidence types, and confirmed that the production disclosure already used native button semantics, `aria-expanded`, `aria-controls`, and a stable panel ID.
- Its accepted contribution in [`SourceEvidencePanel.test.tsx`](apps/web/src/components/SourceEvidencePanel.test.tsx) fixed a regression test that retained a detached DOM-node reference after conditional rendering replaced the toggle button; added keyboard coverage for opening and closing with Enter and Space; and added fallback coverage for unavailable cited source blocks so optional offsets neither corrupt nor duplicate displayed text.
- CodeBuddy did not author the existing production accessibility attributes and did not stage, commit, or push files.

## Evidence-to-requirement matrix

| Submission claim | Implementation | Evidence | Relevant tests |
| --- | --- | --- | --- |
| Hy3 used throughout final workflows | [`hy3Provider.ts`](apps/server/src/llm/hy3Provider.ts), [`provider.ts`](apps/server/src/llm/provider.ts) | [Full demo](docs/assets/hy3-study-clinic-demo.mp4), screenshots [01](docs/assets/01-hy3-grounded-analysis.png), [02](docs/assets/02-hy3-generated-quiz.png), [06](docs/assets/06-hy3-semantic-grading.png) | [`hy3Provider.test.ts`](apps/server/src/llm/hy3Provider.test.ts), [`flows.test.ts`](apps/server/src/routes/flows.test.ts) |
| Interactive frontend | [`App.tsx`](apps/web/src/App.tsx), [`views`](apps/web/src/views) | [Full demo](docs/assets/hy3-study-clinic-demo.mp4), screenshots 01–09 above | [`App.test.tsx`](apps/web/src/App.test.tsx) |
| Grounded concept analysis | [`analysis.ts`](apps/server/src/services/analysis.ts), [`verify.ts`](apps/server/src/grounding/verify.ts) | [Screenshot 01](docs/assets/01-hy3-grounded-analysis.png) | [`verify.test.ts`](apps/server/src/grounding/verify.test.ts), [`flows.test.ts`](apps/server/src/routes/flows.test.ts) |
| Generated grounded quiz | [`quizzes.ts`](apps/server/src/services/quizzes.ts), [`prompts.ts`](apps/server/src/llm/prompts.ts) | [Screenshot 02](docs/assets/02-hy3-generated-quiz.png) | [`flows.test.ts`](apps/server/src/routes/flows.test.ts), [`quizzes.test.ts`](apps/server/src/services/quizzes.test.ts) |
| Hybrid grading | [`grading.ts`](apps/server/src/services/grading.ts), [`score.ts`](apps/server/src/grading/score.ts) | Screenshots [03](docs/assets/03-hy3-grading-result.png) and [06](docs/assets/06-hy3-semantic-grading.png) | [`score.test.ts`](apps/server/src/grading/score.test.ts), [`flows.test.ts`](apps/server/src/routes/flows.test.ts) |
| Mistake remediation | [`remediation.ts`](apps/server/src/services/remediation.ts), [`grading.ts`](apps/server/src/services/grading.ts) | Screenshots [04](docs/assets/04-hy3-remediation-quiz.png) and [07](docs/assets/07-hy3-mistakes-resolved.png) | [`flows.test.ts`](apps/server/src/routes/flows.test.ts) |
| Second end-to-end flow | [`study.ts`](apps/server/src/routes/study.ts), [`MistakesView.tsx`](apps/web/src/views/MistakesView.tsx) | [Full demo](docs/assets/hy3-study-clinic-demo.mp4), screenshots [04](docs/assets/04-hy3-remediation-quiz.png), [07](docs/assets/07-hy3-mistakes-resolved.png), [08](docs/assets/08-hy3-mastery.png) | [`flows.test.ts`](apps/server/src/routes/flows.test.ts), [`App.test.tsx`](apps/web/src/App.test.tsx) |
| Local persistence and history | [`database.ts`](apps/server/src/db/database.ts), [`materials.ts`](apps/server/src/repositories/materials.ts), [`App.tsx`](apps/web/src/App.tsx) | [Screenshot 09](docs/assets/09-material-history-management.png) | [`repos.test.ts`](apps/server/src/repositories/repos.test.ts), [`apps/server/src/routes/materials.test.ts`](apps/server/src/routes/materials.test.ts), [`apps/server/src/services/materials.test.ts`](apps/server/src/services/materials.test.ts), [`App.test.tsx`](apps/web/src/App.test.tsx) |
| Under-two-minute demo | [`docs/assets`](docs/assets) | [1:38.834 demo](docs/assets/hy3-study-clinic-demo.mp4) | Local container-duration inspection |
| Open-source reproducibility | [`package.json`](package.json), [`.env.example`](.env.example), [`ci.yml`](.github/workflows/ci.yml), [`fakeProvider.ts`](apps/server/src/llm/fakeProvider.ts) | [Full demo](docs/assets/hy3-study-clinic-demo.mp4) | 226 passing tests across all workspaces |

## Limitations

- Reopening a material restores its source and concepts, but not historical quiz, submission, or result screens; there is no material-scoped read API for those histories.
- Remediation processes at most three currently open concepts per round.
- Unsubmitted answers live only in React state and are not persisted.
- Permanent deletion has no recycle bin or undo.
- Mastery is a simple exponential moving-average heuristic, not a cognitive diagnosis.
- Strict citation verification can reject otherwise schema-valid model output and require regeneration; the structured-output repair attempt does not repair downstream grounding failures.
- Exact-quote verification proves citation location, not semantic entailment. A standard quiz can also contain fewer questions than requested if invalid questions are rejected but at least one valid question survives.

## License

[Apache-2.0](LICENSE). The built-in Chinese sample course is original repository content released under the same license.
