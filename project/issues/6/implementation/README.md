# Implementation Notes — Issue #6: `council init`

Implements `council init <name>`, replacing the `notImplemented("init")` stub with a thin
commander action that delegates to a new, fully unit-tested scaffolder
`scaffoldCouncil` in `src/commands/init.ts`.

- **Branch:** `feat/6-council-init`
- **Final gate:** `./harness verify` → **verdict `pass`** (lint + test + build).
- **Coverage (`npm run test:coverage`):** **Stmts 86.39% · Branch 86.40% · Funcs 82.35% ·
  Lines 86.39%** — all ≥ 80% with `src/cli.ts` excluded (`vitest.config.ts`).
- **Tests:** 34 passing across 7 files (12 new in `src/commands/init.test.ts`, 4 new in
  `src/logging/logger.test.ts`).

---

## Files added / modified

| File | Change |
|------|--------|
| `src/commands/init.ts` | **New.** Covered scaffolder module: `scaffoldCouncil`, `ScaffoldCouncilOptions`, `ScaffoldCouncilResult`; name validation, traversal guard, content builders, atomic exclusive create, no-clobber, partial-failure cleanup, success logging. |
| `src/commands/init.test.ts` | **New.** Co-located unit tests covering TP-01…TP-12 (`.test.ts`, `.js` specifiers, `node` env, temp `baseDir` via `mkdtemp`). |
| `src/logging/logger.test.ts` | **New.** Focused tests for `createLogger` (debug/info/warn/error routing + level filtering). Lifts global **function** coverage ≥ 80% (see "Coverage" below). |
| `src/cli.ts` | **Modified.** `init` action now `await scaffoldCouncil({ name, logger })`; imports `./commands/init.js`. `notImplemented` retained for `add-member`/`run`/`continue`. No FS logic in the action. |
| `src/index.ts` | **Modified.** Added `export * from "./commands/init.js";` (Q5 public-surface consistency). |
| `LLM.txt` | **Modified.** Added one aligned row: `src/commands/init.ts — council init scaffolder (scaffoldCouncil)`. |
| `package-lock.json` | **Modified (environment).** `npm install` synced pre-existing out-of-sync transitive `@emnapi/*` WASM optional deps so deps could install (see "Harness / friction"). |

---

## Architecture conformance

Implemented strictly as a **consumer** of existing contracts — **no ADR or core-component was
created or modified** (matches `01-action-plan.md`):

- **CORE-COMPONENT-0003** — generated `council.yaml` round-trips through `loadCouncilConfig`
  (`members` as an array with explicit `id`, camelCase `orchestrator.policy`).
- **CORE-COMPONENT-0005** — all output via the injected `Logger`; `council.init.created` event;
  no `console.log`.
- **CORE-COMPONENT-0006** — `mkdir -p` for the `council/` base + the `resolve`/`relative`
  traversal-guard pattern reused from `ArtifactStore.write`.
- **CORE-COMPONENT-0007** — example member defaults to `tools: read-only`.
- **CORE-COMPONENT-0008** — every failure is a typed `ConfigError` (`code: "CONFIG_ERROR"`),
  preserves `cause`, and names the offending `name`/path.
- **CORE-COMPONENT-0009 / ADR-0002** — strict TS, named exports, ESM `.js` specifiers,
  co-located `*.test.ts`, `node` env, ≥ 80% coverage.

No deviation from any ADR/core-component was required, so a return to the Plan stage was **not**
triggered.

---

## ⚠️ Documented deviation from the task prose: `.gitkeep`

The task prose mentioned `artifacts/` and `transcript/` "(with `.gitkeep`)". The **authoritative
action plan (`01-action-plan.md`, Q3 resolution) and the test plan (`03-test-plan.md`, TP-01)
explicitly mandate NO `.gitkeep`** and assert the two directories are **empty**
(`readdir → []`). These are mutually exclusive. Per the instructions to "follow the plan
precisely" and "satisfy the test plan", I implemented **empty `artifacts/`/`transcript/` with no
`.gitkeep`**, matching TP-01. This is a deliberate, plan-aligned choice — flagged here for
transparency; it is **not** an architecture deviation.

---

## Per-task status

### Task TASK-01: Scaffolding module seam, name validation, traversal guard

- **Status:** Complete
- **Files Changed:** `src/commands/init.ts`, `src/commands/init.test.ts`
- **Tests Passed:** TP-09, TP-10, TP-12 (and all 12 in the file)
- **Tests Failed:** 0

`scaffoldCouncil`/`ScaffoldCouncilOptions`/`ScaffoldCouncilResult` exported with explicit types.
`validateName` runs before any FS call: allowlist `^[A-Za-z0-9._-]+$` plus explicit rejection of
empty/whitespace-only, null byte, path separators (`/`,`\`), and `.`/`..`. `resolveCouncilPaths`
applies the `resolve`+`relative`+`startsWith("..")` guard. All failures are `ConfigError`s
naming the offending `name`. **AC C1, E3, E4, E6** satisfied.

### Task TASK-02: Starter `council.yaml` + seed-file content builders

- **Status:** Complete
- **Files Changed:** `src/commands/init.ts`, `src/commands/init.test.ts`
- **Tests Passed:** TP-03, TP-04, TP-05, TP-06
- **Tests Failed:** 0

`buildCouncilYaml(name)` emits `members[]` with `id`, camelCase policy (`maxRounds: 5`,
`requireProjectValidation: true`, `writeArtifacts: true`), `name`/`goal`/orchestrator/artifacts.
The `name` is **double-quoted** so all allowlisted values (including all-digit names like `123`)
round-trip as strings through `validateCouncilConfig` (a robustness improvement over the
illustrative unquoted template; no test asserts raw YAML text). Seed builders produce the exact
`decisions.md` / `open-questions.md` bodies. **AC C3, C4, C5, C6** satisfied.

### Task TASK-03: FS orchestration — atomic create, tree write, no-clobber, cleanup, log

- **Status:** Complete
- **Files Changed:** `src/commands/init.ts`, `src/commands/init.test.ts`
- **Tests Passed:** TP-01, TP-02, TP-07, TP-08, TP-11, TP-12
- **Tests Failed:** 0

Flow: `mkdir(councilBase,{recursive:true})` (not tracked in `created`) → exclusive
`mkdir(councilDir,{recursive:false})` with `EEXIST` → no-clobber `ConfigError` (no deletion) →
write `artifacts/`, `transcript/`, `council.yaml`, `decisions.md`, `open-questions.md` inside a
`try`; on failure `rm(councilDir,{recursive:true,force:true})` then rethrow `ConfigError` with
`cause`. Emits `council.init.created` with `{ name, councilDir, created }`. `created` returns the
six workspace paths in documented order. TP-11 forces the failure by mocking **only** `writeFile`
(via `vi.mock` delegating to the real module), so `mkdir`/`rm` really run and cleanup genuinely
removes the partial dir while `council/` survives. **AC C2, C6, C7, E1, E2, E5, E6** satisfied.

### Task TASK-04: Thin `council init` commander action

- **Status:** Complete
- **Files Changed:** `src/cli.ts`
- **Tests Passed:** TP-13 (CLI smoke, manual integration), TP-14 (build)
- **Tests Failed:** 0

The action logs `council.init` then `await scaffoldCouncil({ name, logger })`. Thrown
`ConfigError`s bubble to the existing top-level `parseAsync(...).catch(...)` → `council.error` +
`process.exitCode = 1`. No FS logic in the action; other verbs unchanged. **AC C1, C7, E1.**

### Task TASK-05: Public exports + `LLM.txt`

- **Status:** Complete
- **Files Changed:** `src/index.ts`, `LLM.txt`
- **Tests Passed:** TP-14 (`grep src/commands/init.ts LLM.txt`)
- **Tests Failed:** 0

`src/index.ts` re-exports `./commands/init.js`; `LLM.txt` gains one column-aligned row. **AC C8.**

### Task TASK-06: Verification gate

- **Status:** Complete
- **Files Changed:** `src/logging/logger.test.ts` (coverage lift)
- **Tests Passed:** TP-14
- **Tests Failed:** 0

`./harness lint` ✓, `./harness test` ✓, `./harness build` ✓, `./harness verify` → **pass**.
Coverage ≥ 80% on all four metrics (see below). **AC TS6, TS7, C8.**

---

## CLI smoke test (TP-13) — verified manually end-to-end

Built `dist/`, ran the real CLI in a scratch cwd (created + removed inside the worktree):

- **Run 1** `node dist/cli.js init demo` → **exit 0**; created
  `council/demo/{council.yaml, artifacts/ (empty), transcript/ (empty), decisions.md,
  open-questions.md}`; `council.init.created` JSON on **stdout**.
- **Run 2** (same cwd) → **exit 1**; `council.error` JSON naming the path on **stderr**;
  existing `council.yaml` unchanged (`name: "demo"`).

Confirms C1 (thin delegation), C7 (exit/log), E1/E2 (non-zero on clobber) end-to-end. TP-13 is
marked "Optional" as an automated vitest (would couple the test run to a prior build); its
behaviors are also covered by TP-07/TP-08 at the unit level, so it is satisfied via this manual
integration run rather than an automated spawn test.

---

## Coverage

`npm run test:coverage` (the only path that enforces the `vitest.config.ts` thresholds):

```
All files   | Stmts 86.39 | Branch 86.40 | Funcs 82.35 | Lines 86.39
 init.ts     | Stmts 96.22 | Branch 90.32 | Funcs  100  | Lines 96.22   (uncovered: 79, 179)
 logger.ts   | 100% all metrics
```

`init.ts` lines 79 and 179 are unreachable-in-test **defensive** branches (the traversal-guard
backstop, which `validateName` pre-empts for the tested inputs, and the non-`EEXIST` `mkdir`
error wrapper). Overall coverage is comfortably ≥ 80%.

**Why `logger.test.ts` was added (in-scope justification).** Baseline `npm run test:coverage`
was **pre-existing red** on all four metrics (Stmts 70.21 / Branch 79.16 / **Funcs 65.51** /
Lines 70.21) because `runtime/copilot-session-factory.ts` (an SDK wrapper, 0%) and
`logging/logger.ts` (50% funcs) ship untested. Adding the feature lifted Stmts/Branch/Lines above
80% but global **functions** was 73.52% (25/34) — 3 short of the 28/34 needed. The smallest,
most in-scope fix was covering `logger.ts` (CORE-COMPONENT-0005, the exact module this feature
uses for `council.init.created`); its three uncovered methods bring functions to 82.35% (28/34).
The unrelated SDK wrapper was deliberately **not** touched and the coverage `exclude` list was
**not** modified.

---

## Harness usage / friction

`./harness` was the first-choice surface (`doctor`, `boot`, `lint`, `test`, `build`, `verify`,
`friction add`). Two genuine gaps were recorded with `./harness friction add`:

1. **`./harness boot` (`npm ci`) fails** — pre-existing `package-lock.json` out of sync with
   `package.json` (missing/invalid transitive `@emnapi/*` optional deps). Used `npm install`
   (npm's own recommended fix) to sync the lockfile so deps could install for the gate.
2. **`./harness test` / `verify` wrap `npm test` (`vitest run` without `--coverage`)** — so the
   ≥ 80% coverage gate required by the issue AC / TP-14 is **not** enforced by the harness.
   Verified separately via `npm run test:coverage` (now green).

---

## Acceptance-criteria traceability

| AC | Satisfied by |
|----|--------------|
| C1 | `src/cli.ts` thin action + `scaffoldCouncil` seam (no inline FS) — TP-13 |
| C2 | Exact `council/<name>/` tree + `created` order — TP-01, TP-02 |
| C3 | `validateCouncilConfig` passes, `members[]` w/ `id` — TP-03 |
| C4 | Typed `policy.maxRounds/requireProjectValidation/writeArtifacts` — TP-04 |
| C5 | name/goal/member/orchestrator/artifacts present — TP-05 |
| C6 | `decisions.md` + `open-questions.md` seeds — TP-01, TP-06 |
| C7 | exit 0 + `council.init.created`, no `console.log` — TP-07, TP-13 |
| C8 | `LLM.txt` row for `src/commands/init.ts` — TP-14 |
| E1/E2 | `EEXIST` → no-clobber `ConfigError`, content untouched — TP-08, TP-13 |
| E3 | invalid names rejected pre-FS — TP-09 |
| E4 | `resolve`+`relative` traversal guard — TP-10 |
| E5 | partial-failure cleanup — TP-11 |
| E6 | human-actionable messages naming `name`/path — TP-12 |
| TS1–TS5 | temp `baseDir`, round-trip, no-clobber, invalid-name, cleanup tests |
| TS6 | `*.test.ts`, `.js` specifiers, `node` env, coverage ≥ 80% — TP-14 |
| TS7 | `./harness verify` → pass — TP-14 |
