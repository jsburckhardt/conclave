# Implementation Notes — Issue #7: `council add-member`

Implements `council add-member <council> <memberId> --cwd <path> --role <role> [--agent <agent>]
[--tools read-only|read-write]`, replacing the `notImplemented("add-member")` stub with a thin
commander action that delegates to a new, fully unit-tested edit module
(`src/config/add-member.ts`). The edit is **validated, comment-preserving, and atomic**
(unique same-directory temp file + `rename`) and never overwrites a council whose pre-existing
`council.yaml` is unparseable or invalid.

- **Branch:** `feat/7-council-add-member`
- **Final gate:** `./harness verify` → **verdict `pass`** (lint + test + build).
- **Coverage (`npm run test:coverage`):** **Stmts 96.45% · Branch 90.80% · Funcs 100% ·
  Lines 96.44%** — all ≥ 80% with `src/cli.ts` excluded (`vitest.config.ts`).
  `add-member.ts` (100/94.44/100/100), `cli-program.ts` (100/60/100/100), and
  `resolveCouncilConfigPath` are all exercised.
- **Tests:** **97 passing across 11 files** — **26 new**: 4 in
  `src/config/council-config.test.ts` (TP-14/TP-15), 20 in `src/config/add-member.test.ts`
  (TP-01…TP-13, TP-16, TP-17 + 2 defensive-branch), 2 in `src/cli-program.test.ts`
  (TP-18, TP-19). No test in the plan (TP-01…TP-21) was skipped.

---

## Files added / modified

| File                                | Change                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/add-member.ts`          | **New.** Covered edit module: `AddMemberOptions`, pure `applyAddMember(doc, member)`, and the `addMember(options)` IO orchestrator; private `validateMemberInput`/`requireNonEmptyString`/`validateTools`, `atomicWriteFile`, and `toCouncilError`. Validation, case-sensitive duplicate guard, `parseDocument` round-trip, re-validation, atomic same-dir write, and entry/success/failure logging. |
| `src/config/add-member.test.ts`     | **New.** 20 co-located unit tests covering TP-01…TP-13, TP-16, TP-17 (+2 defensive branches) — `.test.ts`, `.js` specifiers, `node` env, temp `baseDir` via `mkdtemp`, partial `node:fs/promises` mock for fault injection.                                                                                                                                                                          |
| `src/cli-program.ts`                | **New.** Covered CLI program: `buildProgram(deps?)` wires all four subcommands and the `add-member` flags; `main(argv, deps?)` parses, logs `council.error` (with `code` for `CouncilError`s), and sets `process.exitCode` — never `process.exit`.                                                                                                                                                   |
| `src/cli-program.test.ts`           | **New.** 2 in-process CLI tests (TP-18 add-member success/failure exit codes + structured logs; TP-19 init/run/continue smoke) driven hermetically via injected logger + temp `baseDir`.                                                                                                                                                                                                             |
| `src/config/council-config.ts`      | **Modified.** Added `resolveCouncilConfigPath(council, baseDir = process.cwd())` (CORE-COMPONENT-0003, amended) with the refined `resolve`+`relative` traversal guard shared with `init`; added `join`/`relative`/`resolve` imports. No change to existing exports.                                                                                                                                  |
| `src/config/council-config.test.ts` | **Modified.** Added a `describe("resolveCouncilConfigPath")` block: TP-14 (traversal escapes → `ConfigError`) and TP-15 (path shape `council/<c>/council.yaml`, performs **no** IO).                                                                                                                                                                                                                 |
| `src/cli.ts`                        | **Modified (now a thin shim).** Reduced to `#!/usr/bin/env node` + `import { main } from "./cli-program.js"` + `void main(process.argv)`. Stays coverage-excluded; all business logic moved to the covered `cli-program.ts`.                                                                                                                                                                         |
| `src/index.ts`                      | **Modified.** Added `export * from "./config/add-member.js";` (public surface: `addMember`/`applyAddMember`/`AddMemberOptions`). `resolveCouncilConfigPath` is already re-exported via the existing `council-config.js` barrel line.                                                                                                                                                                 |
| `LLM.txt`                           | **Modified.** Added two aligned rows (`src/config/add-member.ts`, `src/cli-program.ts`) and reworded the `src/cli.ts` row to "CLI entry shim → delegates to cli-program". No unrelated rows reworded.                                                                                                                                                                                                |
| `README.md`                         | **Modified.** Documented the `add-member` flags and added a **Limitations** subsection (single-writer last-writer-wins concurrency; `run`/`continue` config-path reconciliation follow-up).                                                                                                                                                                                                          |
| `.harness/friction.jsonl`           | **Modified (process).** Recorded that `./harness test`/`verify` wrap `vitest run` **without** `--coverage`, so the ≥80% gate is not harness-enforced; proven via `npm run test:coverage`.                                                                                                                                                                                                            |

---

## Architecture conformance

Implemented strictly **within** the architecture. The Plan stage had already **amended
CORE-COMPONENT-0003** (adding `resolveCouncilConfigPath`) and recorded DECISION-LOG decisions
**#17–#20**; this implementation consumes those contracts and required **no further** ADR or
core-component change — so a return to the Plan stage was **not** triggered.

- **CORE-COMPONENT-0003 (configuration)** — `resolveCouncilConfigPath` is the single source of
  truth for `council/<council>/council.yaml`. The edit re-uses `validateCouncilConfig` and
  persists `String(doc)` from the mutated `yaml` `Document` — **never** the normalized validator
  return — so comments, key order, and unknown keys survive.
- **CORE-COMPONENT-0005 (logging)** — all output via the injected `Logger`: `council.add-member`
  `{council, memberId}` on entry, `council.add-member.succeeded` `{council, memberId, tools}` on
  success, and `council.add-member.failed` `{council, memberId, code}` **before** re-throwing.
  No `console.log`.
- **CORE-COMPONENT-0007 (permission policy)** — `--tools` accepts **only** `read-only` |
  `read-write`, defaults to `read-only`, and is never coerced.
- **CORE-COMPONENT-0008 (error handling)** — every failure is a typed `ConfigError`
  (`code: "CONFIG_ERROR"`); `toCouncilError` preserves an existing `CouncilError`'s code and wraps
  anything else with `cause`. Messages name the offending path / field.
- **CORE-COMPONENT-0009 / ADR-0002** — strict TS, named exports, ESM `.js` import specifiers,
  co-located `*.test.ts`, `node` env, ≥80% coverage; no new dependencies (reuses `yaml`).

---

## Per-task status

### Task TASK-01: `resolveCouncilConfigPath` resolver and traversal guard

- **Status:** Complete · **Files:** `src/config/council-config.ts`, `src/config/council-config.test.ts`
- **Tests Passed:** TP-14, TP-15 · **Tests Failed:** 0

`resolveCouncilConfigPath(council, baseDir = process.cwd())` returns
`join(resolve(baseDir,"council",council), "council.yaml")` after the refined guard
(`rel.length === 0 || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")` →
`ConfigError` naming `<council>`), mirroring `init`'s `resolveCouncilPaths`. Performs **no** FS
IO (TP-15 asserts this against a non-existent `baseDir`). Re-exported via the existing barrel.
**AC C3, E8.**

### Task TASK-02: Input validation and pure `applyAddMember(doc, member)`

- **Status:** Complete · **Files:** `src/config/add-member.ts`, `src/config/add-member.test.ts`
- **Tests Passed:** TP-02, TP-03, TP-04, TP-05, TP-06, TP-10 · **Tests Failed:** 0

`validateMemberInput` trims and enforces: `memberId` matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`;
`--cwd`/`--role` required non-empty after trim (field-naming messages); `--agent` optional
(stored trimmed only if non-empty); `--tools` exactly `read-only`|`read-write`, default
`read-only`, anything else rejected (not coerced). Pure `applyAddMember(doc, member)` appends to
the `members` sequence of a parsed `Document` and throws a conflict `ConfigError` on a
case-sensitive, trimmed duplicate id **before** mutating. **AC C2, E2, E3, E4, E5.**

### Task TASK-03: Atomic same-directory write helper

- **Status:** Complete · **Files:** `src/config/add-member.ts`, `src/config/add-member.test.ts`
- **Tests Passed:** TP-11, TP-12, TP-13 · **Tests Failed:** 0

`atomicWriteFile` writes to a uniquely named temp file in the **same** directory
(`.<basename>.<pid>.<randomUUID()>.tmp`), then `rename`s it over the original; on any error it
`rm`s the temp (`{ force: true }`, swallowing cleanup errors) and re-throws the cause. TP-11
asserts no leftover temp file; TP-13 runs sequential **and** concurrent (`Promise.all`) adds and
re-reads a valid, uncorrupted file with no stray temp. **AC C8, E9.**

### Task TASK-04: `addMember(options)` IO orchestration

- **Status:** Complete · **Files:** `src/config/add-member.ts`, `src/config/add-member.test.ts`
- **Tests Passed:** TP-01, TP-07, TP-08, TP-09, TP-12, TP-16, TP-17 · **Tests Failed:** 0

Flow (logging-bracketed): `resolveCouncilConfigPath` (outside the try, so a traversal escape
throws raw with no logs) → `council.add-member` entry log → `validateMemberInput` → `readFile`
(missing dir/file → `ConfigError` naming the path) → `parseDocument`; if `doc.errors.length > 0`
(malformed) → `ConfigError`, **never** overwrite → `applyAddMember` (duplicate guard) → a
**single re-validation** `validateCouncilConfig(doc.toJS())` **after** the edit (per the
authoritative action plan), which also blocks a **pre-existing-invalid but parseable**
`council.yaml` as well as any edit-induced invalidity → persist `String(doc)` via
`atomicWriteFile` → `council.add-member.succeeded`. Any failure logs `council.add-member.failed`
with `code` **before** re-throwing. Never calls `process.exit`. TP-12 forces a post-parse
validation failure and asserts the on-disk bytes are unchanged. **AC C5, C6, C7, C9, C10, E1, E6,
E7.**

### Task TASK-05: CLI wiring — `src/cli-program.ts` (buildProgram/main) + `src/cli.ts` shim

- **Status:** Complete · **Files:** `src/cli-program.ts`, `src/cli.ts`, `src/cli-program.test.ts`
- **Tests Passed:** TP-18, TP-19 · **Tests Failed:** 0

Moved the commander program into a **covered** `src/cli-program.ts` (`buildProgram(deps?)`,
`main(argv, deps?)`) and reduced `src/cli.ts` to a 3-line shim. The `add-member` action adds
`--cwd`/`--role` (required), `--agent` (optional), `--tools` (default `read-only`) and delegates
entirely to `addMember`. `main` logs `council.error` with `error.code` for `CouncilError`s and
sets `process.exitCode = 1`. TP-18 drives a non-existent council (→ exit 1 + structured
`council.add-member.failed`/`council.error` carrying `code: "CONFIG_ERROR"`) and a valid council
(→ exit 0 + start/success logs + member appended); TP-19 smokes init/run/continue. **AC C1.**

### Task TASK-06: Public exports and documentation

- **Status:** Complete · **Files:** `src/index.ts`, `LLM.txt`, `README.md`
- **Tests Passed:** TP-20 (greps + barrel type-check + `--help`) · **Tests Failed:** 0

Barrel re-exports `addMember`/`applyAddMember`/`AddMemberOptions` (and `resolveCouncilConfigPath`
via the existing line); `node dist/cli.js add-member --help` lists all four flags with
`(default: "read-only")`; `README.md` Limitations subsection matches
`grep -i "single-writer\|concurren\|limitation"`. **AC C2 (help), E9 (documented limitation).**

### Task TASK-07: Verification gate — coverage ≥80% and `./harness verify`

- **Status:** Complete · **Files:** _(verification only)_
- **Tests Passed:** TP-21 · **Tests Failed:** 0

`./harness lint` ✓, `./harness test` ✓ (97 passing), `./harness build` ✓, `./harness verify` →
**pass**. `npm run test:coverage` exits 0 with all four metrics ≥80% (see below). **AC TS11.**

---

## Coverage

`npm run test:coverage` (the only path that enforces the `vitest.config.ts` thresholds; exits 0):

```
All files       | Stmts 96.45 | Branch 90.80 | Funcs  100 | Lines 96.44
 cli-program.ts  | Stmts  100  | Branch 60.00 | Funcs  100 | Lines  100   (uncovered branches: 35, 111-117)
 add-member.ts   | Stmts  100  | Branch 94.44 | Funcs  100 | Lines  100   (uncovered branch: 159-185 region)
 council-config.ts (resolveCouncilConfigPath) — exercised by TP-14/TP-15
```

`cli-program.ts`'s uncovered branches are the injected-logger fallback (`deps.logger ??
createLogger()`) and the `String(error)` / non-`CouncilError` arms of the `council.error` handler
— not reachable when a `Logger` is injected and a typed `CouncilError` is thrown. Overall coverage
is comfortably ≥80% on every metric; `src/cli.ts` (the shim) remains excluded per
`vitest.config.ts`.

---

## Harness usage / friction

`./harness` was the first-choice surface (`orient`, `doctor`, `boot`, `lint`, `test`, `build`,
`verify`, `friction add`). One gap was recorded with `./harness friction add` (consistent with the
precedent from issues #4 and #6):

- **`./harness test` / `verify` wrap `npm test` (`vitest run` without `--coverage`)** — so the
  ≥80% lines/branches/functions/statements thresholds in `vitest.config.ts` are **not** enforced
  by the harness, and there is no `harness coverage` verb. Proven separately via
  `npm run test:coverage` (green: 96.45/90.80/100/96.44). Suggest a `harness coverage` verb or
  having `test` pass `--coverage`.

---

## Acceptance-criteria traceability

| AC       | Satisfied by                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1       | Stub replaced; thin `add-member` action delegates to `addMember` — TP-18, TP-19                                                                                                                                     |
| C2       | `--cwd`/`--role`/`--agent`/`--tools`; default `read-only` — TP-02, TP-20                                                                                                                                            |
| C3       | Append to `council/<council>/council.yaml` via `resolveCouncilConfigPath` — TP-01, TP-14, TP-15                                                                                                                     |
| C4       | `yaml` `Document` API preserves comments/order/orchestrator — TP-10                                                                                                                                                 |
| C5       | Re-validate; write only on pass — TP-01, TP-09                                                                                                                                                                      |
| C6       | Edit logic in `src/config/add-member.ts`, not the action — TP-01…TP-17                                                                                                                                              |
| C7       | Pre-existing members/orchestrator/unknown keys survive — TP-10                                                                                                                                                      |
| C8       | Atomic write: unique same-dir temp + `rename` + cleanup — TP-11, TP-12                                                                                                                                              |
| C9       | Entry/success/failure logs; failure carries `code` — TP-16, TP-17, TP-18                                                                                                                                            |
| C10      | Non-zero exit on failure; file byte-for-byte unchanged — TP-03, TP-08, TP-09, TP-12, TP-17, TP-18                                                                                                                   |
| E1       | Missing dir/file → `ConfigError`; nothing created — TP-07                                                                                                                                                           |
| E2       | Duplicate `memberId` (case-sensitive, trimmed) rejected — TP-03                                                                                                                                                     |
| E3       | Invalid `--tools` rejected (not coerced) — TP-04                                                                                                                                                                    |
| E4       | Empty/whitespace/non-string fields rejected — TP-05                                                                                                                                                                 |
| E5       | `memberId` charset enforced — TP-06                                                                                                                                                                                 |
| E6       | Malformed YAML → `ConfigError`; not overwritten — TP-08                                                                                                                                                             |
| E7       | Parseable-but-invalid → `ConfigError`; not overwritten — TP-09                                                                                                                                                      |
| E8       | `<council>` cannot traverse outside the council root — TP-14                                                                                                                                                        |
| E9       | Concurrent adds cannot corrupt; limitation documented — TP-13, TP-20                                                                                                                                                |
| TS1–TS10 | Add+reload, default/explicit tools, duplicate-unchanged, missing-config, invalid-tools, field/charset, malformed/invalid YAML, comment round-trip, sequential+concurrent, in-process CLI — TP-01…TP-13, TP-16…TP-19 |
| TS11     | Co-located `*.test.ts`, `.js` specifiers, coverage ≥80% — TP-21 (+ all unit tests)                                                                                                                                  |
