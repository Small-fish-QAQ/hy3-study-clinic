# Hy3 Study Clinic Repository Instructions

## Product identity

The product name is:

Hy3 Study Clinic

Preserve this name throughout the UI, README, documentation, package metadata, APIs, database objects, and code.

Do not introduce product branding such as:

* Study Clinic 2.0
* Study Clinic V2
* Hy3 Study Clinic Next
* API v2
* GraphV2
* WorkspaceV2

Technical database migration numbers are allowed when required by the existing migration convention.

This work is an evidence-grounded adaptive-learning upgrade to the existing product, not a separate product rewrite.

## Product mission

Hy3 Study Clinic helps learners:

1. organize one or more course documents;
2. construct an evidence-grounded concept graph;
3. visualize personal mastery and mistakes on that graph;
4. receive grounded assessments and remediation plans from Hy3;
5. preserve deterministic, auditable control over grading and persistent learning state.

Do not turn the application into a generic document-chat platform or a collection of unrelated AI features.

## Existing architectural principles

Preserve these boundaries:

* Hy3 performs semantic extraction, grounded generation, relationship proposal, semantic grading, and learning-strategy proposal.
* Local deterministic code validates citations, IDs, graph structure, objective answers, scores, state transitions, persistence, budgets, and permissions.
* Model output must pass runtime schema validation before use.
* Model-generated evidence must be validated against existing source blocks.
* The model must not directly modify mastery, close mistakes, delete history, or mutate persistent learning state.
* Failed AI generation must not overwrite previously valid data.
* Fake and real providers must share compatible provider contracts.
* Offline development and tests must remain deterministic.
* Existing request cancellation and stale-response protection must be preserved and extended to new workflows.

## Repository and Git rules

This is an independent repository.

Work only on the currently checked-out branch.

Do not:

* create another branch;
* switch branches;
* rename branches;
* merge;
* rebase;
* reset;
* clean;
* amend existing commits;
* force any Git operation;
* push to any remote;
* modify remote configuration.

Never discard uncommitted user changes.

Make focused local commits after coherent implementation phases.

Leave the worktree clean when the task is complete.

## Technology constraints

Continue using the existing monorepo and its current:

* TypeScript;
* React;
* Fastify;
* Zod;
* SQLite;
* testing tools;
* build tools;
* formatting and linting tools.

Prefer extending existing schemas, services, repositories, routes, providers, state management, and persistence mechanisms over creating parallel systems.

Do not introduce:

* Neo4j;
* a vector database;
* LangChain;
* authentication;
* mobile applications;
* microservices;
* Kubernetes;
* a new backend language;
* arbitrary shell execution;
* unrelated chat, social, or administration features.

A small and actively maintained dependency may be added when it provides substantial value for:

* PDF extraction;
* DOCX extraction;
* graph rendering;
* safe graph layout.

Document every new production dependency and why it was selected.

## Implementation quality

Before modifying code:

1. inspect the complete repository architecture;
2. identify reusable schemas, services, repositories, routes, providers, tests, and frontend state;
3. run the existing verification suite;
4. record baseline results;
5. identify compatibility requirements for existing data and workflows.

Do not duplicate:

* concept models;
* mastery calculations;
* grounding validators;
* provider interfaces;
* request-state systems;
* persistence layers;
* grading logic;
* mistake lifecycle logic.

Keep domain logic out of route handlers and React components.

Every persistent feature must include:

* an explicit migration;
* repository support;
* service-level validation;
* API schemas;
* automated tests.

Every asynchronous frontend operation must handle:

* loading;
* errors;
* cancellation where supported;
* stale responses;
* switching or deleting the active workspace or document.

## AI-output requirements

All important real-provider output must use structured, runtime-validated contracts.

Do not parse important output using fragile regular expressions.

Graph relations and remediation plans must:

* reference only existing IDs;
* use controlled enums;
* include valid source evidence;
* reject unknown entities;
* reject invalid evidence;
* deduplicate normalized results;
* enforce local limits and budgets.

Do not expose private chain-of-thought.

The UI may show:

* concise plan summaries;
* selected concepts;
* evidence references;
* requested operations;
* local validation results;
* final rationales.

## Evidence requirements

Exact quotation validation proves that quoted text exists at the claimed source position.

It does not independently prove complete semantic entailment.

Preserve this distinction in code, UI, and documentation.

Every accepted graph edge and remediation-plan reason must retain provenance to existing source blocks.

## Verification requirements

After implementation, run every applicable repository command, including:

* builds;
* TypeScript checks;
* linting;
* formatting checks;
* shared tests;
* server tests;
* frontend tests;
* integration tests;
* migration tests;
* git diff checks.

Add tests for every new critical path and meaningful failure mode.

Never remove, skip, weaken, or rewrite an existing test merely to make the suite pass, unless previous behavior is deliberately changed and the reason is documented.

Tests must never depend on the real external Hy3 API.

## Documentation requirements

Update the README and architecture documentation to explain:

* the upgraded product workflow;
* what Hy3 does;
* what deterministic local code does;
* workspace and document organization;
* supported document formats;
* provenance;
* graph generation and validation;
* learner-state overlay;
* remediation planning;
* known limitations;
* fake-provider setup;
* real-Hy3 setup;
* exact verification commands.

Do not claim unimplemented or unverified capabilities.
