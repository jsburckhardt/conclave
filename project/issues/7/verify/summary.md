# Verify Summary — #7

## Feature Overview

**Issue:** #7 — feat(cli): implement `council add-member` to add a validated member to a council

Delivered `council add-member <council> <memberId> --cwd <path> --role <role> [--agent <agent>] [--tools read-only|read-write]`, replacing the `notImplemented("add-member")` stub with a thin commander action that delegates to a new, fully unit-tested edit module `src/config/add-member.ts`. The module validates inputs (trim/charset/enum with field-naming errors), rejects case-sensitive trimmed duplicate ids, edits the parsed `yaml` `Document` (preserving comments, key order, the orchestrator section, and unknown/forward-compat keys), re-validates the full config with `validateCouncilConfig`, and persists `String(doc)` via an atomic same-directory unique-temp-plus-`rename` write that never overwrites an unparseable or already-invalid `council.yaml`. A shared, exported `resolveCouncilConfigPath(council, baseDir?)` locator (CORE-COMPONENT-0003, amended) is the single source of truth for `council/<council>/council.yaml` behind a `resolve`+`relative` traversal guard. The commander program moved into a covered `src/cli-program.ts` (`buildProgram`/`main`) so CLI behaviour is unit-testable in-process, leaving `src/cli.ts` a 3-line shim. Ships with 26 new tests (97 total across 11 files); all verification steps and all 30 acceptance criteria pass.

## Branch & PR

| Field | Value |
|-------|-------|
| Branch | `feat/7-council-add-member` |
| PR | [feat(cli): implement council add-member to add a validated member to a council](https://github.com/jsburckhardt/conclave/pull/11) |

## Commits

| Hash | Message |
|------|---------|
| 6d2707c | docs(plan): record research and plan for #7 council add-member |
| 6995afc | feat(config): add resolveCouncilConfigPath locator (TASK-01, #7) |
| 2d55346 | feat(config): add validated council add-member edit module (TASK-02/03/04, #7) |
| 0231731 | feat(cli): extract covered cli-program with add-member wiring (TASK-05, #7) |
| 32fad28 | docs(config): export add-member, document command + limitations (TASK-06, #7) |
| f7895bd | docs(impl): record issue #7 implementation notes + verify evidence (TASK-07, #7) |
| 8f69d1d | chore(harness): record verify gate evidence for #7 |

## Acceptance Criteria

All 30 criteria (10 Core, 9 Edge, 11 Testing) are satisfied with code + test evidence.

| Status | Criterion | Evidence |
|--------|-----------|----------|
| ✅ passed | Core: `council add-member <council> <memberId>` replaces the `notImplemented("add-member")` stub in `src/cli.ts`. | `src/cli.ts` is a shim → `main` in `src/cli-program.ts`; `buildProgram` wires `add-member` → `await addMember(...)`; stub grep returns none. Tests TP-18, TP-19. |
| ✅ passed | Core: member fields via `--cwd`, `--role`, `--agent` (optional), `--tools`; `--tools` defaults to `read-only` (CORE-COMPONENT-0007). | `cli-program.ts` `.requiredOption(--cwd/--role)`, `.option(--agent)`, `.option(--tools, "read-only")`; `validateTools` defaults `read-only`. Tests TP-02, TP-20. |
| ✅ passed | Core: a new member is appended to `council/<council>/council.yaml` via the `yaml` package; path from the shared exported `resolveCouncilConfigPath(council)`. | `council-config.ts:resolveCouncilConfigPath` (re-exported via `src/index.ts`); `applyAddMember` uses `parseDocument`/`members.add`. Tests TP-01, TP-14, TP-15. |
| ✅ passed | Core: editing uses the `yaml` Document API so comments, key order, and the orchestrator section are preserved. | Mutates the parsed `Document`; persists `String(doc)`. Test TP-10. |
| ✅ passed | Core: the full config is re-validated with `validateCouncilConfig` after the edit; written back only when validation passes. | `validateCouncilConfig(doc.toJS())` precedes `atomicWriteFile`. Tests TP-01, TP-09. |
| ✅ passed | Core: edit logic lives in `src/config/add-member.ts`, not the commander action. | The `add-member` action only calls `addMember({...})`. Tests TP-01…TP-17. |
| ✅ passed | Core: pre-existing members, the orchestrator section, and unknown/forward-compat keys survive (persist the edited document, not the normalized output). | `String(doc)` is written. Test TP-10 asserts `unknownKey`, orchestrator, and `alice` survive. |
| ✅ passed | Core: writes are atomic — a uniquely named same-dir temp file is `rename`d over the original and removed on error. | `atomicWriteFile` `.<base>.<pid>.<uuid>.tmp` + `rename` + `rm` on error. Tests TP-11, TP-12. |
| ✅ passed | Core: on entry/success/failure the shared logger emits records; the failure record includes `code` plus `council` and `memberId`. | `council.add-member` / `.succeeded` / `.failed {code}`. Tests TP-16, TP-17, TP-18. |
| ✅ passed | Core: on any failure the command exits non-zero and leaves `council.yaml` byte-for-byte unchanged. | Re-throw → `main` sets `process.exitCode = 1`; never `process.exit`. Tests TP-03, TP-08, TP-09, TP-12, TP-18. |
| ✅ passed | Edge: a missing council directory or `council.yaml` fails with an actionable `ConfigError`; nothing created. | `readFile` failure → `ConfigError` naming the path + `council init` hint. Test TP-07. |
| ✅ passed | Edge: a duplicate `memberId` (case-sensitive, trimmed) is rejected with a clear conflict error; file unchanged. | `applyAddMember` duplicate scan throws before mutating. Test TP-03 (`Alice` ≠ `alice`). |
| ✅ passed | Edge: an invalid `--tools` value is rejected (not silently coerced). | `validateTools` throws on a non-enum value. Test TP-04. |
| ✅ passed | Edge: empty/whitespace/non-string `memberId`, `--cwd`, or `--role` are rejected with field-naming errors. | `requireNonEmptyString`. Test TP-05. |
| ✅ passed | Edge: a `memberId` violating `^[A-Za-z0-9][A-Za-z0-9._-]*$` (incl. `.`/`..`) is rejected. | `MEMBER_ID_PATTERN` check. Test TP-06. |
| ✅ passed | Edge: malformed (unparseable) YAML surfaces a `ConfigError` and is not overwritten. | `doc.errors.length > 0` → `ConfigError`. Test TP-08. |
| ✅ passed | Edge: a parseable-but-already-invalid `council.yaml` surfaces a `ConfigError` and is not overwritten. | Post-edit `validateCouncilConfig` blocks it. Test TP-09. |
| ✅ passed | Edge: the `<council>` argument cannot traverse outside the council root. | `resolveCouncilConfigPath` `resolve`+`relative` guard. Tests TP-14 (`../../etc`). |
| ✅ passed | Edge: two concurrent runs cannot corrupt the file; the single-writer limitation is documented. | Unique-temp + `rename`; `README.md` Limitations. Test TP-13. |
| ✅ passed | Testing: adding a member then re-reading via `loadCouncilConfig` returns the new member. | Test TP-01 (`add-member.test.ts`). |
| ✅ passed | Testing: duplicate `memberId` rejected (throws; file unchanged). | Test TP-03. |
| ✅ passed | Testing: omitting `--tools` yields `read-only`; explicit `read-write` is preserved. | Test TP-02. |
| ✅ passed | Testing: missing council/`council.yaml` throws `ConfigError`. | Test TP-07. |
| ✅ passed | Testing: invalid `--tools` is rejected. | Test TP-04. |
| ✅ passed | Testing: missing/whitespace required fields and charset-invalid `memberId` rejected with field-naming messages. | Tests TP-05, TP-06. |
| ✅ passed | Testing: malformed and parseable-but-invalid YAML both throw `ConfigError` without overwriting. | Tests TP-08, TP-09. |
| ✅ passed | Testing: comments, unknown keys, orchestrator, and pre-existing members survive a round-trip add. | Test TP-10. |
| ✅ passed | Testing: sequential and concurrent adds leave a valid, uncorrupted file (no leftover temp). | Test TP-13. |
| ✅ passed | Testing: in-process `buildProgram()`/`main(argv)` — non-existent council exits non-zero with a structured error log; success exits 0 with start + success logs. | Test TP-18 (`cli-program.test.ts`). |
| ✅ passed | Testing: tests co-located `*.test.ts`, ESM `.js` specifiers, coverage ≥ 80% (vitest thresholds). | `npm run test:coverage` green: 96.45 / 90.80 / 100 / 96.44 (stmts/branch/funcs/lines), `src/cli.ts` excluded. Test TP-21. |

## ADRs & Core-Components

CORE-COMPONENT-0003 was **amended** by the Plan stage (adding `resolveCouncilConfigPath`, the canonical `council/<council>/council.yaml` layout, and the persist-the-document rule), and `DECISION-LOG.md` records the derived decisions #17–#20 (dated 2026-06-21) — both already reflected in the changeset, so no further DECISION-LOG update was required. No new ADR or agent definition was introduced. Referenced architecture:

| ID | Title |
|----|-------|
| ADR-0002 | TypeScript + GitHub Copilot SDK Multi-Session Runtime |
| CORE-COMPONENT-0003 | Configuration (amended: `resolveCouncilConfigPath` locator + on-disk layout + persist-the-document rule; DECISION-LOG #17–#20) |
| CORE-COMPONENT-0004 | Session Identity & Lifecycle (motivates the strict `memberId` charset) |
| CORE-COMPONENT-0005 | Logging and Observability |
| CORE-COMPONENT-0006 | Artifact and Transcript Store (mirrored traversal-guard pattern) |
| CORE-COMPONENT-0007 | Permission Policy (`tools` read-only default) |
| CORE-COMPONENT-0008 | Error Handling (`ConfigError` / `CONFIG_ERROR`, `cause`) |
| CORE-COMPONENT-0009 | Development Standards |

## Verification Results

| Category | Command | Status |
|----------|---------|--------|
| lint (eslint) | `./harness verify` → Lint | pass |
| format check (prettier) | `./harness verify` → Lint | pass |
| type check (tsc --noEmit) | `./harness verify` → Lint | pass |
| test (vitest run) | `./harness verify` → Test | pass (97 tests, 11 files) |
| build (tsc) | `./harness verify` → Build | pass |
| coverage ≥ 80% | `npm run test:coverage` | pass — 96.45 / 90.80 / 100 / 96.44, `src/cli.ts` excluded |

`./harness verify` overall verdict: **pass**. The harness `test`/`verify` verbs wrap `vitest run` **without** `--coverage`, so the ≥ 80% coverage criterion was verified independently via `npm run test:coverage`; this gap is recorded in `.harness/friction.jsonl`.

### Follow-ups

- Reconcile `council run`/`council continue` to the shared `resolveCouncilConfigPath` (they still default `--config` to a flat `council.yaml`). Documented in `README.md` Limitations — **recommend filing a tracked GitHub issue**.
- Single-writer concurrency (no cross-process lock on `council.yaml`; atomic `rename` prevents corruption, not lost updates) is a documented v0 limitation; file locking is a future enhancement.

## Generated At

2026-06-21T01:13:55Z
