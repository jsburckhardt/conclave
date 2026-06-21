# Implementation Notes: Issue #5 — `council run` fixed backlog phases and artifact generation

Branch: `feat/5-council-run` · Worktree: `.trees/issue-5`

Implements the fixed v0 backlog-council flow per
`project/issues/5/plan/01-action-plan.md`, `02-task-breakdown.md`, and the 27-case
`03-test-plan.md`. Stays strictly within ADR-0002 and CORE-COMPONENT-0003/0004/0005/0006/0007/0008/0009.
**No ADR/core-component divergence occurred** — no Plan-stage return required.

## Files created / modified

| File | Change |
|---|---|
| `src/errors.ts` | **+** `OrchestrationError extends CouncilError` (`code: "ORCHESTRATION_ERROR"`, `name`, `cause` forwarded), mirroring `ConfigError`/`SessionError`. |
| `src/errors.test.ts` | **+** TP-01: `OrchestrationError` shape, `cause`, hierarchy, and package-root export identity. |
| `src/runtime/council-phases.ts` | **NEW** covered orchestrator module (no SDK import). `runBacklogCouncil`, pure `normalizePolicy`/`resolveRoles`/`resolveArtifactPath`, and the six phase prompt builders. |
| `src/runtime/council-phases.test.ts` | **NEW** co-located suite (TP-02…TP-24, TP-26 + 2 branch-coverage tests). Recording/throwing/blank fake `SessionFactory`, real runtime + real temp stores. |
| `src/cli.test.ts` | **NEW** TP-25 hermetic CLI smoke (config-load failure path via `tsx`). |
| `src/cli.ts` | Replaced `notImplemented("run")` with the thin wired action (build stores/factory/runtime from `config.name`, guarded `try/finally` `stop()`); enhanced the top-level catch to log `code` for `CouncilError`. `add-member`/`continue` unchanged. |
| `src/index.ts` | **+** `export * from "./runtime/council-phases.js";` (`OrchestrationError` already surfaced via `./errors.js`). |
| `LLM.txt` | **+** row for `src/runtime/council-phases.ts`; annotated `src/errors.ts` with `OrchestrationError`. |

> Architecture docs (DECISION-LOG, CORE-COMPONENT-0004/0006/0008) were finalized by the Plan
> stage and were **not** modified here.

## Public API as implemented

```ts
// src/runtime/council-phases.ts
export interface NormalizedPolicy {
  writeArtifacts: boolean;
  requireProjectValidation: boolean;
  maxRounds: number;
}
export interface RunBacklogCouncilOptions {
  artifacts: ArtifactStore; // required: the orchestrator writes through CC-0006
  logger?: Logger;          // defaults to createLogger()
}
export interface BacklogCouncilResult {
  contextMemberId: string;
  backlogMemberId: string;
  phases: string[];          // de-duplicated, ordered: ["context","draft","validation","refinement","artifacts"]
  rounds: number;            // == normalized maxRounds
  artifacts: string[];       // absolute paths written ([] when writeArtifacts:false)
  validationSkipped: boolean;// true when requireProjectValidation === false
  artifactsSkipped: boolean; // true when writeArtifacts === false
}

export function normalizePolicy(policy?: OrchestratorPolicy): NormalizedPolicy;            // pure
export function resolveRoles(config: CouncilConfig): { contextMemberId: string; backlogMemberId: string }; // pure, fail-closed
export function resolveArtifactPath(logical: string, configArtifacts: string[]): string;  // pure
export function contextPrompt(goal): string;       // pure prompt builders (no preamble)
export function draftPrompt(summary): string;
export function validationPrompt(backlog): string;
export function refinementPrompt(backlog, validation?): string; // omits validation block when undefined
export function epicsPrompt(backlog): string;
export function openQuestionsPrompt(backlog): string;

export async function runBacklogCouncil(
  runtime: CouncilRuntime, config: CouncilConfig, options: RunBacklogCouncilOptions,
): Promise<BacklogCouncilResult>;
```

**Flow:** `normalizePolicy` (phase 0, no side effects) → `resolveRoles` (fail-closed) →
**context** (`contextMemberId`) → **draft** (`backlogMemberId`) → `for r in 0..maxRounds`:
optional **validation** (`contextMemberId`, gated) then **refinement** (`backlogMemberId`) →
optional **artifacts** (`backlog.md`, then targeted `epics.md` / `open-questions.md` asks).
Every ask goes through a private `askNonBlank` that enforces `trim().length > 0` and relies on
`CouncilRuntime.askMember` for the single transcript append (never double-appends). Each
`ArtifactStore.write` is wrapped so the store's plain `Error` becomes `OrchestrationError(cause)`.

**Default role heuristic (Option B, documented in JSDoc + `LLM.txt`):**
context source ← `/\b(context|project|product|architect|repo|codebase|source of truth)\b/i`;
backlog author ← `/\b(scrum|backlog|stor(y|ies)|sprint|agile|product owner)\b/i`. Must resolve to
two **distinct** members or `OrchestrationError` (missing / ambiguous / non-distinct). No member id
is hardcoded.

---

## Per-task status

## Task TASK-01: Add `OrchestrationError` and export it

- **Status:** Done
- **Files Changed:** `src/errors.ts`, `src/errors.test.ts`
- **Tests Passed:** 6 (errors.test.ts)
- **Tests Failed:** 0

### Changes Summary
Added `OrchestrationError` with `code: "ORCHESTRATION_ERROR"`, `name`, and forwarded `cause`. Re-exported via the existing `export * from "./errors.js"` in `src/index.ts`.

### Test Results
TP-01 passes: `code`/`name`/`cause`/`instanceof CouncilError` all asserted; root export identity (`index.ts` class === `errors.ts` class) verified.

### Notes
No change to `CouncilError`/`ConfigError`/`SessionError` behavior (regression guard holds).

## Task TASK-02: `normalizePolicy`

- **Status:** Done
- **Files Changed:** `src/runtime/council-phases.ts`, `src/runtime/council-phases.test.ts`
- **Tests Passed:** TP-02, TP-03, TP-04, TP-05 (+ TP-18/TP-19 at flow level)
- **Tests Failed:** 0

### Changes Summary
Pure, exported. Defaults `{writeArtifacts:true, requireProjectValidation:true, maxRounds:1}`; defensive boolean coercion; `ConfigError` on non-integer/negative `maxRounds` (names the value); `OrchestrationError` on the `requireProjectValidation && maxRounds===0` contradiction.

### Test Results
All four metric branches exercised (valid/invalid maxRounds, contradiction true/false, each default). `(false, 0)` accepted.

### Notes
Reconciles research R1 (loader passes `policy` untyped) — validation lives here, not in the loader.

## Task TASK-03: `resolveRoles`

- **Status:** Done
- **Files Changed:** `src/runtime/council-phases.ts`, `src/runtime/council-phases.test.ts`
- **Tests Passed:** TP-06, TP-07, TP-08, TP-09
- **Tests Failed:** 0

### Changes Summary
Fail-closed heuristic (Option B — no `config.orchestrator.roles` read, which the loader drops, research R3). 0/1/>1 matches per role + distinctness check, each raising actionable `OrchestrationError`.

### Test Results
Distinct happy path → `proj`/`scrum`; single-member scaffold → missing-`backlog` error; two backlog matches → ambiguous (both ids named); single member matching both → non-distinct error.

### Notes
Guarantees a single-member `council init` scaffold always fails role resolution with an actionable message (research R8).

## Task TASK-04: Core ask sequence — prompts, phases, rounds, blank-checks, logging

- **Status:** Done
- **Files Changed:** `src/runtime/council-phases.ts`, `src/runtime/council-phases.test.ts`
- **Tests Passed:** TP-11, TP-13, TP-16, TP-17, TP-20, TP-21, TP-22, TP-24 (+ zero-round test)
- **Tests Failed:** 0

### Changes Summary
Six pure prompt builders (adapted from `prd.md:359–414`, **no preamble**); `refinementPrompt` omits the validation block when `validation` is undefined. `askNonBlank` centralizes the `trim()` blank-check; phase order context → draft → (validation) → refinement via `askMember`; structured dotted logs with ids/counts only.

### Test Results
Exact `(memberId, prompt)` order asserted; transcript block count == asks (6); validation-skip + refine-from-draft; rounds bounded by `maxRounds`; blank in every phase → `OrchestrationError`; mid-phase throw propagates untouched; unknown member → `SessionError`; no SDK import; no hardcoded ids.

### Notes
Logs never contain prompt/response bodies (asserted in TP-11; research R7).

## Task TASK-05: Artifact phase — targeted asks, write wrapping, gating, result assembly

- **Status:** Done
- **Files Changed:** `src/runtime/council-phases.ts`, `src/runtime/council-phases.test.ts`
- **Tests Passed:** TP-10, TP-12, TP-14, TP-15, TP-20 (epics/open-questions), TP-23, TP-23b (traversal)
- **Tests Failed:** 0

### Changes Summary
`epicsPrompt`/`openQuestionsPrompt` targeted asks (Q4); `resolveArtifactPath` basename-matches `config.artifacts`, else defaults `artifacts/<logical>.md` (Q7). `writeArtifacts:false` skips all asks+writes. Each write wrapped → `OrchestrationError(cause)`; `BacklogCouncilResult` assembled with absolute paths.

### Test Results
Three artifacts written to expected paths with non-blank content; re-run overwrites `backlog.md` in place while the transcript doubles (append-only, CC-0006); `writeArtifacts:false` → no files + `artifactsSkipped`; write failure and path-traversal both surface as `OrchestrationError` with the store's `Error` as `cause`, transcript intact.

### Notes
Members stay read-only; the council itself performs all artifact writes (CC-0007).

## Task TASK-06: Thin `council run` action + structured error codes

- **Status:** Done
- **Files Changed:** `src/cli.ts`, `src/cli.test.ts`
- **Tests Passed:** TP-25 (hermetic), reinforced by TP-21/TP-26 at unit level
- **Tests Failed:** 0

### Changes Summary
Wired the action: `base = join("council", config.name)` (Q9), `TranscriptStore`, `ArtifactStore`, `CopilotSessionFactory`, `CouncilRuntime`; `try { start(); runBacklogCouncil(); log council.run.complete } finally { guarded stop() }`. Top-level catch logs `{ code, error }` for `CouncilError`, else `{ error }`; non-zero exit. `cli.ts` is coverage-excluded; all logic stays in `council-phases.ts`.

### Test Results
Hermetic failure path: `council run` with a missing config exits non-zero and emits a `council.error` JSON line carrying `code` (`CONFIG_ERROR`) and message — proving C1 (no `notImplemented`), Q6 (`code` in catch), and non-zero exit. `stop()`-in-`finally` and no-masking proven by TP-21/TP-26.

### Notes
**Scope of TP-25 (documented in `03-test-plan.md` as optional/best-effort):** the success path and the
role-resolution → `OrchestrationError` CLI path are **not hermetic** — `runtime.start()` creates real
SDK sessions *before* role resolution runs (verified empirically: a single-member run fails in
`session.create`, not in role resolution). The deterministic, always-runnable CONFIG_ERROR path is used
in CI; the typed-error → `code` plumbing is identical for every `CouncilError` subclass, and the
`OrchestrationError` cases are fully covered at unit level (TP-07/08/09/18/19). No harness verb was
bypassed, so no `./harness friction add` entry was required.

## Task TASK-07: Unit tests, fakes, public surface, `LLM.txt`

- **Status:** Done
- **Files Changed:** `src/runtime/council-phases.test.ts`, `src/cli.test.ts`, `src/errors.test.ts`, `src/index.ts`, `LLM.txt`
- **Tests Passed:** all 27 TP cases (+ 2 extra branch tests)
- **Tests Failed:** 0

### Changes Summary
Recording/throwing/blank fake `SessionFactory` + real `CouncilRuntime`/temp stores exercise the full flow without the SDK. `src/index.ts` re-exports the module; `LLM.txt` row added.

### Test Results
107 tests pass overall. `council-phases.ts` 100% lines/branches/functions/statements.

### Notes
Extra tests: "zero rounds when `maxRounds:0` + validation off" and "defaults the logger when `options.logger` omitted" close the last branches.

## Task TASK-08: Verification gate

- **Status:** Done
- **Files Changed:** — (gate only)
- **Tests Passed:** 107
- **Tests Failed:** 0

### Test Results
`./harness verify` → **pass** (Lint pass, Test pass, Build pass). `npm run test:coverage` exits 0; thresholds (≥80% all metrics) met.

### Notes
Evidence: `.harness/evidence/verify-20260621T005907Z.json`.

---

## Acceptance-criteria satisfaction

**Core**
- **C1** `council run` loads config, runs `runBacklogCouncil`, exits 0; no `notImplemented` — `src/cli.ts`; TP-25.
- **C2** New `council-phases.ts`; **no `@github/copilot-sdk` import**; fake-factory runnable — TP-11/TP-24.
- **C3** Phases context → draft → (validation) → refinement via `askMember` — TP-11.
- **C4** Roles resolved from `config.members`; `project-x`/`scrum-sme` not hardcoded — TP-06/TP-24.
- **C5** `writeArtifacts` → backlog/epics/open-questions via `ArtifactStore.write` from `config.artifacts` — TP-10/TP-12.
- **C6** One transcript block per exchange (never double-appends) — TP-13.
- **C7** Policy honored + defaults (`requireProjectValidation`/`writeArtifacts`/`maxRounds`) — TP-02/05/16/17.
- **C8** `stop()` in `finally`; failure does not mask — TP-21/TP-26 + `src/cli.ts`.
- **C9** `OrchestrationError` added, exported from `index.ts`, registered in CC-0008 — TP-01.
- **C10** Re-run overwrites artifacts in place, appends transcript — TP-14.

**Edge**
- **E1** Unknown member id → `SessionError` (no silent skip) — TP-22.
- **E2** Unresolved/ambiguous/non-distinct role → actionable `OrchestrationError` — TP-07/08/09.
- **E3** Mid-phase throw → typed error, prior transcript preserved, `stop()` runs — TP-21.
- **E4** Blank (post-`trim()`) response → `OrchestrationError`; never written empty — TP-20.
- **E5** Artifact write failure → `OrchestrationError(cause)`; logged; transcript intact — TP-23.
- **E6** `writeArtifacts:false` → all phases + transcript, no artifact files — TP-15.
- **E7** `requireProjectValidation:false` skips validation, refines from draft — TP-16.
- **E8** Contradiction → `OrchestrationError`; bad `maxRounds` → `ConfigError` — TP-03/04/18/19.

**Testing**
- **TS1** Full-flow exact call-order — TP-11. **TS2** Artifact paths + non-blank — TP-12.
- **TS3** Transcript block count — TP-13. **TS4** Policy gating — TP-15/16/17/18.
- **TS5** Typed-error propagation — TP-20/21/22/23. **TS6** Coverage ≥80% + `./harness verify` — TP-27.

## Final results

| Gate | Verdict |
|---|---|
| `./harness lint` | **pass** (eslint ✓, prettier ✓, typecheck ✓) |
| `./harness test` | **pass** — 107 tests, 11 files |
| `./harness build` | **pass** |
| `./harness verify` | **pass** |
| `npm run test:coverage` | **pass** (exit 0; thresholds met) |

**Coverage (v8):** overall **96.51% statements / 93.54% branches / 100% functions / 96.44% lines**;
`src/runtime/council-phases.ts` = **100% / 100% / 100% / 100%**. `src/cli.ts` excluded per
`vitest.config.ts` (kept thin). Thresholds were not weakened and no file was excluded to game coverage.
