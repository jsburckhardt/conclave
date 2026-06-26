# Implementation Notes — Issue #3: `council continue` (resume)

Implements `council continue <council>` to resume a persisted council from a durable
`state.json` checkpoint, **plus** the producer hook so `council run` writes and checkpoints
that state end-to-end. Built strictly to the ratified plan
(`plan/01-action-plan.md`, `plan/02-task-breakdown.md`, `plan/03-test-plan.md`) and the amended
core-components CC-0004 (resume contract), CC-0006 (`CouncilStateStore`/`state.json`/atomic
write/`.council.lock`), CC-0008 (`StateError`). **No architecture docs were edited** (the planner
owns those; records #30–38 in `DECISION-LOG.md`). **No new runtime dependencies** — `node:crypto`
is used for `configHash` and the lock payload.

All work was done in the worktree `/.trees/issue-3` (branch `feat/3-council-continue`).
**Git operations are intentionally NOT performed** — the Verify stage owns commits/PR.

---

## Final quality gates — all green

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `./harness lint` (eslint + prettier:check + typecheck) | ✅ pass |
| Test | `./harness test` (`vitest run`, no coverage) | ✅ pass — **180 tests, 18 files** |
| Build | `./harness build` (`npm run build` / tsc) | ✅ pass |
| Verify | `./harness verify` (lint + test + build) | ✅ pass |
| Coverage | `npm run test:coverage` (≥80% gate, `vitest.config.ts`) | ✅ pass — see below |

### Coverage (≥80% global thresholds enforced on all four metrics)

```
All files     | % Stmts 96.16 | % Branch 89.41 | % Funcs 98.11 | % Lines 96.41
  commands/continue.ts   100 stmts | 83.33 branch | 100 funcs | 100 lines
  commands/run.ts        100 stmts | 66.66 branch | 100 funcs | 100 lines
  commands/shared.ts      80 stmts | 50    branch | 100 funcs | 78.57 lines
  store/atomic-write.ts  100 | 100 | 100 | 100
  store/council-lock.ts  81.25 | 88.88 | 71.42 | 92.85
  store/council-state-store.ts  92.3 | 90.19 | 100 | 92.3
  errors.ts              100 | 100 | 100 | 100
```

The few uncovered branches are **deliberate default-dependency fallbacks** never exercised in
hermetic tests (e.g. `options.baseDir ?? process.cwd()`, `options.logger ?? createLogger()`,
`options.sessionFactory ?? new CopilotSessionFactory()`) and the `shared.ts` config read/parse
error paths, which are exercised by the out-of-process `cli.test.ts` (a subprocess, so not counted
by v8). The global gate passes comfortably.

---

## Files changed

### Created (code)
- `src/store/atomic-write.ts` — shared `atomicWriteFile(targetPath, content)` (temp file + `rename`).
- `src/store/council-state-store.ts` — `CouncilStateStore` + `CouncilState` types + `STATE_SCHEMA_VERSION`; schema-validating `read()` (throws `StateError`), atomic `write()` (`mkdir -p`), `exists()`.
- `src/store/council-lock.ts` — `CouncilLock` (atomic `wx` create, `--force` clears stale, best-effort `release`) + `councilConfigHash(raw)` (sha256 hex via `node:crypto`).
- `src/commands/shared.ts` — internal run/continue helpers: `loadConfigWithRaw`, `sessionIdFor`, `memberRegistry`, `assertCouncilIdentity`, `toCouncilError`.
- `src/commands/run.ts` — `runCouncil(options)` producer (canonical path → fail-fast validation → lock → initial/checkpoint/terminal state).
- `src/commands/continue.ts` — `continueCouncil(options)` resume orchestration (read state → identity/drift/session-id guards → lock → resume + checkpoints + terminal).

### Created (tests, co-located)
- `src/store/atomic-write.test.ts` (TP-02)
- `src/store/council-state-store.test.ts` (TP-03..07)
- `src/store/council-lock.test.ts` (TP-08, TP-09)
- `src/commands/run.test.ts` (TP-24 + force/stop-error branch coverage)
- `src/commands/continue.test.ts` (TP-14..23 + defensive-branch coverage)

### Modified
- `src/errors.ts` — added `StateError extends CouncilError` (code `STATE_ERROR`).
- `src/errors.test.ts` — added TP-01 `StateError` shape/export tests.
- `src/config/add-member.ts` — now imports the shared `atomicWriteFile` (removed the private copy; R7).
- `src/runtime/council-phases.ts` — additive, backward-compatible `resume` + `checkpoint` on `runBacklogCouncil` (`ResumePoint`/`PhaseCheckpoint` types + resume state machine + per-phase/round checkpoints).
- `src/runtime/council-phases.test.ts` — TP-10..13 resume/checkpoint tests.
- `src/cli-program.ts` — `run`/`continue` actions are now thin adapters delegating to `runCouncil`/`continueCouncil`; both accept `--force`; removed the `notImplemented` helper + `continue` stub.
- `src/cli-program.test.ts` — rewrote the old TP-19 assertion as **TP-25** (continue logs `council.continue`, fails `STATE_ERROR`, exit 1; `../escape` → `ConfigError`; `--force` parses).
- `src/index.ts` — exports `./commands/run.js` + `./commands/continue.js` (state store + lock already exported).
- `.gitignore` — ignores `council/**/.council.lock` and `council/**/.*.tmp`; `state.json` stays tracked (Q6).
- `LLM.txt` — documents `council continue` + `--force` and the new command/store modules.

### Not touched (planner-owned)
`project/architecture/ADR/DECISION-LOG.md`, `CORE-COMPONENT-0004/0006/0008` were amended by the
Plan stage and are left exactly as-is.

---

## Per-task status

## Task TASK-01: `StateError`

- **Status:** Complete
- **Files Changed:** `src/errors.ts`, `src/errors.test.ts`
- **Tests Passed:** 9 (errors.test.ts)
- **Tests Failed:** 0

### Changes Summary
Added `StateError` (code `STATE_ERROR`) to the `CouncilError` hierarchy; auto-exported via `src/index.ts`.

### Test Results
TP-01: `instanceof StateError/CouncilError/Error`, `code === "STATE_ERROR"`, `name`, `cause` preserved, exported from the package root.

### Notes
A single `STATE_ERROR` code covers missing/corrupt/incompatible-schema/lock-conflict; the specific remedy lives in the message (CC-0008).

## Task TASK-02: Shared `atomicWriteFile`

- **Status:** Complete
- **Files Changed:** `src/store/atomic-write.ts`, `src/store/atomic-write.test.ts`, `src/config/add-member.ts`
- **Tests Passed:** TP-02 (3) + add-member regression (20)
- **Tests Failed:** 0

### Changes Summary
Extracted the byte-identical `atomicWriteFile` from `add-member` into a shared module; `add-member` now imports it.

### Test Results
TP-02: writes content, temp file is same-dir + removed on success, orphan temp removed on `rename` failure. add-member suite unchanged (temp-name regex still matches).

### Notes
Used by `CouncilStateStore.write` and `add-member`, so a reader never observes a partial file.

## Task TASK-03: `CouncilStateStore`

- **Status:** Complete
- **Files Changed:** `src/store/council-state-store.ts`, `src/store/council-state-store.test.ts`, `src/index.ts`
- **Tests Passed:** 7 (TP-03..07)
- **Tests Failed:** 0

### Changes Summary
Read/write of `council/<slug>/state.json` with the ratified schema. `read()` validates `schemaVersion` first, then every field, throwing `StateError` (actionable "no prior run" for ENOENT). `write()` does `mkdir -p` + `atomicWriteFile` with a trailing newline.

### Test Results
TP-03 atomic round-trip + `mkdir -p`; TP-04 missing → typed error naming `council run <slug>`; TP-05 corrupt/partial → `StateError`; TP-06 unknown/newer `schemaVersion` → `StateError`; TP-07 valid → typed `CouncilState`.

### Notes
A corrupt/absent file is **never** coerced to an empty/fresh state (R4).

## Task TASK-04: `CouncilLock` + `councilConfigHash`

- **Status:** Complete
- **Files Changed:** `src/store/council-lock.ts`, `src/store/council-lock.test.ts`, `src/index.ts`
- **Tests Passed:** 4 (TP-08, TP-09)
- **Tests Failed:** 0

### Changes Summary
`CouncilLock.acquire` uses an atomic `wx` create (TOCTOU-safe), throwing `StateError` on conflict; `--force` clears a stale lock first; `release` is best-effort/idempotent. `councilConfigHash` is sha256-hex of the raw `council.yaml` bytes.

### Test Results
TP-08 acquire → conflict → `--force` → release lifecycle; TP-09 hash deterministic + change-sensitive.

## Task TASK-05: `resume` + `checkpoint` in `runBacklogCouncil`

- **Status:** Complete
- **Files Changed:** `src/runtime/council-phases.ts`, `src/runtime/council-phases.test.ts`
- **Tests Passed:** 38 (TP-10..13 + regression)
- **Tests Failed:** 0

### Changes Summary
Backward-compatible additions: `ResumePoint`/`PhaseCheckpoint` and `resume`/`checkpoint` options. A resume state machine skips completed phases (seeding from `products`), and a checkpoint callback fires after each completed phase/round with the minimal products payload. Phase knowledge stays out of `CouncilRuntime` (Q7); the callback keeps the orchestrator ignorant of the state schema (CC-0004 boundary).

### Test Results
TP-10 checkpoint payloads per phase/round; TP-11 resume `draft` skips context+draft; TP-12 resume `context` runs draft onward; TP-13 resume `validation` resumes mid-round at refinement. No-checkpoint regression identical.

## Task TASK-06: `runCouncil` + producer hook

- **Status:** Complete
- **Files Changed:** `src/commands/run.ts`, `src/commands/run.test.ts`, `src/commands/shared.ts`, `src/cli-program.ts`, `src/index.ts`
- **Tests Passed:** 4 (TP-24 + force/stop-error)
- **Tests Failed:** 0

### Changes Summary
`runCouncil` resolves the canonical council dir, fails fast on policy/roles/identity **before** any side effect, then under `.council.lock` writes the initial `in-progress` state, checkpoints per phase/round, and writes a terminal `completed` state. The `run` CLI action is now a thin adapter (+`--force`).

### Test Results
TP-24 initial→checkpoint→terminal write sequence (initial precedes `start()`; atomic, no orphan temp; lock created-then-removed; `name !== slug` → `ConfigError` before any session). Added: `--force` clears a stale lock; failing `stop()` logs `council.stop.error` without masking completion.

## Task TASK-07: `continueCouncil`

- **Status:** Complete
- **Files Changed:** `src/commands/continue.ts`, `src/commands/continue.test.ts`, `src/commands/shared.ts`, `src/index.ts`
- **Tests Passed:** 14 (TP-14..23 + defensive branches)
- **Tests Failed:** 0

### Changes Summary
Resume flow per the action plan: canonical path + identity guard → `state.read()` (`StateError`) → `councilId` cross-check → idempotent-completed no-op → member-set drift (`ConfigError` unless `--force`) / non-structural drift (warn) → session-id cross-check → lock → `start()` (SDK fail → `SessionError`, state untouched) → resume + checkpoints → terminal `completed`. Failures log `council.continue.failed { code }` and re-throw a typed `CouncilError`.

### Test Results
TP-14 stable-id reuse; TP-15 missing → `StateError`; TP-16 corrupt + newer schema → `StateError`; TP-17 member-set drift abort vs `--force`; TP-18 non-structural drift warns; TP-19 completed no-op; TP-20 SDK fail → `SessionError`, bytes preserved, lock released; TP-21 lock conflict → `StateError`, `--force` clears; TP-22 identity mismatch → `ConfigError`; TP-23 resumes from `lastPhase`/`lastRound`, re-persists atomically. Plus councilId/session-id/length-drift/stop-error branches.

## Task TASK-08: CLI wiring + `.gitignore` + TP-19 rewrite

- **Status:** Complete
- **Files Changed:** `src/cli-program.ts`, `src/cli-program.test.ts`, `.gitignore`, `LLM.txt`
- **Tests Passed:** 3 (cli-program.test.ts incl. TP-25)
- **Tests Failed:** 0

### Changes Summary
Replaced the `continue` stub with a delegating adapter (`-c/--config`, `--force`); removed `notImplemented`; added `--force` to `run`. Ignored `.council.lock` + `.*.tmp` (Q6). Documented the command in `LLM.txt`.

### Test Results
TP-25: `continue smoke` logs `council.continue` + `council.continue.failed { STATE_ERROR }` + `council.error { STATE_ERROR }`, exit 1; `continue ../escape` → `ConfigError`; `--force` parses without a Commander error.

## Task TASK-09: Verification gate

- **Status:** Complete
- **Files Changed:** — (gate only)
- **Tests Passed:** 180 (full suite)
- **Tests Failed:** 0

### Changes Summary
`./harness lint`, `./harness build`, `./harness test`, `./harness verify` all green; `npm run test:coverage` passes the ≥80% gate (96.16/89.41/98.11/96.41). `src/index.ts` exports `StateError`, `CouncilStateStore`, `CouncilLock`, `councilConfigHash`, `runCouncil`, `continueCouncil` (verified against the built `dist`).

### Test Results
TP-26: coverage gate green; no `console.log` in source; all intra-project imports use `.js`; `tsc --noEmit` clean.

---

## Key decisions & assumptions

1. **`checkpoint` callback over injecting the store into `runBacklogCouncil`** (CC-0004 boundary):
   the orchestrator owns phases/rounds/products only; identity fields + the full schema belong to the
   command + `CouncilStateStore`. Keeps the orchestrator schema-ignorant and fully testable.
2. **Canonical path + identity invariant** (Q3): both `run` and `continue` resolve
   `council/<slug>/...` via `resolveCouncilConfigPath` (slug-validated, traversal-guarded) and enforce
   `config.name === <slug> === state.councilId`. `state.councilId` is additionally cross-checked
   (defense-in-depth), and each stored `sessionId` is re-derived and compared (never trusted, R4).
3. **`-c/--config` default dropped for `run`** (was `"council.yaml"`): omitting it now resolves the
   canonical `council/<slug>/council.yaml` (consistent with `add-member`/`continue`); an explicit
   `--config` still overrides. Existing CLI tests pass an explicit path, so behavior is preserved.
4. **Fail-fast ordering in `run`:** `normalizePolicy` → `resolveRoles` → `assertCouncilIdentity`
   run before any lock/state write, so an invalid council leaves no side effects (and the existing
   `cli.test.ts` ORCHESTRATION_ERROR fast-paths still fail before the identity guard).
5. **`continue` writes nothing before `runtime.start()`** — so an SDK resume failure leaves
   `state.json` byte-for-byte unchanged (retryable). The lock is acquired before the inner
   `try/finally`, so a pre-existing (un-forced) lock conflict never deletes someone else's lock.
6. **Drift policy** (Q-resolved): member-id **set** change is structural → `ConfigError` unless
   `--force` (warns `config.drift { member-set }`); a pure `configHash` change with an identical
   member set is non-structural → warns `config.drift { non-structural }` and continues.
7. **`toCouncilError`** added to `shared.ts` (mirrors the `add-member` precedent) so `continue`'s
   top-level catch attaches a machine-readable `code`. `add-member`'s private copy was left untouched
   (smallest-change principle).
8. **Resumed-run `result.phases`** reports the full journey (`context…artifacts`) with the rounds
   counter seeded to the resumed point — chosen for consistency; not asserted by any TP test.
9. **Logging** (CC-0005, ids/counts/phase names only — never prompt/response bodies):
   `council.continue[.resumed|.completed|.failed]`, `council.run[.complete]`, `state.read`,
   `state.write`, `config.drift`, `lock.acquired/released/forced`, `council.stop.error`.

## Architectural compliance

No deviations from any ADR or core-component were required. The implementation stays within the
contracts documented in CC-0004/0006/0008 and ADR-0002, uses only `node:*` + the existing `yaml`/
`commander` deps, and matches the ratified `state.json` schema and `continueCouncil` flow.
