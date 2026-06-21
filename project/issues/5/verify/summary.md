# Verify Summary — #5

## Feature Overview

**Issue:** #5 — feat(runtime): implement `council run` fixed backlog phases and artifact generation

Delivered the v0 `council run` orchestration. A new, SDK-decoupled `runBacklogCouncil` orchestrator in `src/runtime/council-phases.ts` drives an already-started `CouncilRuntime` through a deterministic phase order — context summary → backlog draft → optional project validation → refinement → optional artifact generation — resolving the context-source and backlog-author member ids from config via a documented, fail-closed heuristic (never hardcoded), honoring the `writeArtifacts` / `requireProjectValidation` / `maxRounds` policy and its precedence rules, writing `backlog.md` / `epics.md` / `open-questions.md` through `ArtifactStore.write`, and appending every exchange to the append-only `TranscriptStore`. A new typed `OrchestrationError` (`ORCHESTRATION_ERROR`) covers blank responses, unresolved/ambiguous roles, contradictory policy, and wrapped artifact-write failures. `council run` was wired in `src/cli.ts` to build the stores/factory/runtime, run the phases, and stop the runtime in a guarded `finally` so a `stop()` failure never masks the primary error.

## Branch & PR

| Field | Value |
|-------|-------|
| Branch | `feat/5-council-run` |
| PR | [feat(runtime): implement council run fixed backlog phases and artifact generation](https://github.com/jsburckhardt/conclave/pull/10) |

## Commits

| Hash | Message |
|------|---------|
| 6d27290 | feat(runtime): add backlog council phase orchestrator and council run wiring |
| 5677769 | docs(architecture): register OrchestrationError and phase/policy contracts |
| fb93d45 | docs(issues): add issue #5 research, plan, and implementation records |
| 686d3c9 | chore(harness): record verify evidence for #5 |

## Acceptance Criteria

| Status | Criterion | Evidence |
|--------|-----------|----------|
| ✅ passed | `council run <name>` loads `council.yaml`, runs the council, and exits 0 on success (no more `notImplemented`). | `src/cli.ts` `run` action loads config, builds stores/factory/runtime, calls `runtime.start()` → `runBacklogCouncil` → logs `council.run.complete`; CLI smoke test `src/cli.test.ts` (TP-25). |
| ✅ passed | New `src/runtime/council-phases.ts` orchestrator depends only on `CouncilRuntime`/stores (no SDK import), runnable with a fake `SessionFactory`. | `runBacklogCouncil`; `council-phases.test.ts` TP-24 asserts the source contains no `@github/copilot-sdk`; every test drives it with a recording fake factory. |
| ✅ passed | Phases execute in order context → draft → (validation) → refinement via `askMember`. | `runBacklogCouncil` phase loop; TP-11 asserts the exact `(memberId, prompt)` call order. |
| ✅ passed | Context/backlog ids resolved from config (documented heuristic); `project-x`/`scrum-sme` not hardcoded. | `resolveRoles` regex heuristic; TP-06, TP-24. Plan Q1 deliberately chose the heuristic-only branch the AC permits via "or". |
| ✅ passed | `writeArtifacts` enabled → `backlog.md`/`epics.md`/`open-questions.md` via `ArtifactStore.write` from `config.artifacts`. | `writeArtifact` + `resolveArtifactPath`; TP-12 asserts the three relative paths and non-blank content. |
| ✅ passed | Every exchange appended to `TranscriptStore` (one block per turn), append-only across re-runs. | `CouncilRuntime.askMember` + `TranscriptStore.append` (appendFile); TP-13, TP-14. |
| ✅ passed | Policy honored: `requireProjectValidation`, `writeArtifacts`, `maxRounds` per documented defaults (§8). | `normalizePolicy`; TP-02, TP-05, TP-15, TP-16, TP-17. |
| ✅ passed | `runtime.stop()` runs in `finally` on every path; a `stop()` failure does not mask the original error. | `src/cli.ts` guarded `finally`; TP-21, TP-26. |
| ✅ passed | `OrchestrationError` (`ORCHESTRATION_ERROR`) added, exported from `src/index.ts`, registered in CORE-COMPONENT-0008. | `src/errors.ts`, `src/index.ts`; CORE-COMPONENT-0008 doc; `errors.test.ts` TP-01 (+ root-export identity). |
| ✅ passed | Re-running overwrites artifacts in place and appends (does not truncate) the transcript. | `ArtifactStore.write` (writeFile) + `TranscriptStore.append`; TP-14 asserts overwrite v1→v2 and doubled transcript blocks. |
| ✅ passed | A phase referencing an unknown member id raises a typed error (no silent skip). | `CouncilRuntime.askMember` throws `SessionError`; TP-22. |
| ✅ passed | Unresolved/ambiguous role, or a council lacking both roles, raises a typed error with an actionable message. | `resolveRoles`/`resolveSingleRole`; TP-07 (missing/single), TP-08 (ambiguous, names candidates), TP-09 (not distinct). |
| ✅ passed | A member that throws mid-phase propagates a typed error, preserves transcript turns, and still triggers `stop()`. | TP-21 asserts `SessionError`, two preserved blocks, `stop()` called once. |
| ✅ passed | A blank (empty/whitespace) response in any phase raises `OrchestrationError`. | `askNonBlank`; TP-20 parametrized across all six phases. |
| ✅ passed | An artifact-write failure raises a typed error wrapping the cause, is logged, and keeps the transcript. | `writeArtifact` try/catch wraps in `OrchestrationError` with `cause`, logs `phase.artifacts.error`; TP-23 (mock reject + path-traversal). |
| ✅ passed | `writeArtifacts: false` runs all phases + transcript but writes no artifact files. | Skip branch logs `phase.artifacts.skipped`; TP-15 asserts no artifacts dir, transcript still written. |
| ✅ passed | `requireProjectValidation: false` skips validation and refines directly from the draft. | Skip branch logs `phase.validation.skipped`; TP-16. |
| ✅ passed | `requireProjectValidation: true` + `maxRounds: 0` raises a typed error; negative/non-integer `maxRounds` raises `ConfigError`. | `normalizePolicy`; TP-03, TP-04, TP-18, TP-19. |
| ✅ passed | Full-flow unit test with a fake `SessionFactory` asserts the exact `(memberId, prompt)` order. | TP-11. |
| ✅ passed | Tests assert artifacts at expected relative paths under the `ArtifactStore` base with non-blank content. | TP-12. |
| ✅ passed | Tests assert the transcript contains one appended block per exchange. | TP-13. |
| ✅ passed | Tests assert policy gating (validation skip, no files when `writeArtifacts: false`, `maxRounds` bound, contradictory throws). | TP-15, TP-16, TP-17, TP-18. |
| ✅ passed | Tests assert typed-error propagation (unknown/unresolved/ambiguous member, mid-phase throw + `stop()`, blank, write failure). | TP-20, TP-21, TP-22, TP-23, TP-07/08/09. |
| ✅ passed | `./harness test` passes with coverage ≥ 80%; `./harness lint` and `./harness build` pass. | `./harness verify` = pass; `npm run test:coverage` exit 0, global 96.51% stmts / 93.54% branches / 100% funcs / 96.44% lines; `council-phases.ts` 100%. |

## ADRs & Core-Components

| ID | Title |
|----|-------|
| ADR-0002 | TypeScript + GitHub Copilot SDK Multi-Session Runtime |
| CORE-COMPONENT-0003 | Configuration |
| CORE-COMPONENT-0004 | Session Lifecycle and Persistence |
| CORE-COMPONENT-0005 | Logging and Observability |
| CORE-COMPONENT-0006 | Artifact and Transcript Store |
| CORE-COMPONENT-0007 | Permission Policy |
| CORE-COMPONENT-0008 | Error Handling |

## Verification Results

| Category | Command | Status |
|----------|---------|--------|
| install | `npm ci` | ✅ pass |
| type_check | `npm run typecheck` | ✅ pass |
| lint | `npm run lint` | ✅ pass |
| format_check | `npm run format:check` | ✅ pass |
| test | `npm test` | ✅ pass |
| build | `npm run build` | ✅ pass |
| coverage | `npm run test:coverage` | ✅ pass (≥ 80% gate; 96.51% stmts / 93.54% branches / 100% funcs / 96.44% lines) |

The `type_check`, `lint`, `format_check`, `test`, and `build` steps were executed together via `./harness verify` (which wraps the same package scripts); `install` was validated with `npm ci`; the coverage gate was confirmed with `npm run test:coverage`.

## Generated At

2026-06-21T01:12:34Z
