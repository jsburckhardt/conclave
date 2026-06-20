# Task Breakdown: Issue #6 — `council init`

Source plan: `project/issues/6/plan/01-action-plan.md`.
Test cases (TP-IDs) are defined in `project/issues/6/plan/03-test-plan.md`.

**Acceptance-criterion IDs** (from the issue, used throughout):
Core `C1`–`C8`, Edge `E1`–`E6`, Testing `TS1`–`TS7`.

---

## Task TASK-01: Scaffolding module seam, name validation, and traversal guard

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** None
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0008, CORE-COMPONENT-0006, CORE-COMPONENT-0003, CORE-COMPONENT-0009

### Description
Create the new covered module `src/commands/init.ts` and export the
`scaffoldCouncil(options: ScaffoldCouncilOptions): Promise<ScaffoldCouncilResult>` seam with
the exact signature in the action plan (`name`, optional `baseDir`, optional `logger`; result
`{ councilDir, created }`). Implement the **pure input-safety layer** only (no tree writing
yet):

- A `name` validator that runs **before any filesystem call**: allowlist `^[A-Za-z0-9._-]+$`
  plus explicit rejection of empty/whitespace-only, `.`, `..`, path separators (`/`, `\`), and
  null byte (`\u0000`). Each failure throws `ConfigError` (CORE-COMPONENT-0008) whose message
  names the offending `name`.
- A traversal guard (defense-in-depth) reusing the `ArtifactStore.write` pattern
  (`src/store/artifact-store.ts:15-21`): `councilBase = resolve(baseDir ?? process.cwd(),
  "council")`, `councilDir = resolve(councilBase, name)`, reject when
  `relative(councilBase, councilDir)` is empty / `..` / starts with `..`.

Members serialization, FS writes, and logging are **out of scope** for this task (TASK-02/03).

### Acceptance Criteria
- [ ] `src/commands/init.ts` exists and exports `scaffoldCouncil`, `ScaffoldCouncilOptions`,
      and `ScaffoldCouncilResult` with explicit types (named exports; CORE-COMPONENT-0009). (`C1`)
- [ ] Invalid names — `""`, `"   "`, `"."`, `".."`, `"a/b"`, `"a\\b"`, `"a\u0000b"` — each
      reject with `ConfigError` (`code === "CONFIG_ERROR"`) **before** any FS write, and no
      `council/<name>` directory is created. (`E3`)
- [ ] A `name` that would resolve outside `council/` is rejected by the `resolve`+`relative`
      guard, not by string matching alone; for every accepted name,
      `relative(councilBase, councilDir) === name`. (`E4`)
- [ ] All thrown messages are human-actionable and name the offending `name`. (`E6`)
- [ ] No filesystem logic for tree creation lives in `src/cli.ts`; the logic is in this
      module. (`C1`)

### Test Coverage
- Co-located `src/commands/init.test.ts` (`.test.ts`, `.js` import specifiers, `node` env;
  CORE-COMPONENT-0009), mirroring `src/store/artifact-store.test.ts`.
- **TP-09** (invalid-name classes rejected, no dir created) — must cover all seven classes.
- **TP-10** (traversal guard: positive invariant + `..` rejection).
- **TP-12** (error messages name the offending `name`).
- This module is included in coverage; its exported functions must reach ≥80% (CORE-COMPONENT-0009).

---

## Task TASK-02: Starter `council.yaml` and seed-file content builders

- **Status:** Planned
- **Complexity:** Low-Medium
- **Dependencies:** TASK-01
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0003, CORE-COMPONENT-0007, CORE-COMPONENT-0008

### Description
Implement the **pure content builders** (no FS) that produce the starter file bodies:

- `council.yaml` body for a given `name` — emitting `members` as an **array** with explicit
  `id`, and `orchestrator.policy` in **camelCase** (`maxRounds: 5`,
  `requireProjectValidation: true`, `writeArtifacts: true`), exactly as in the action plan.
  Include `name` (= `<name>`), a `goal`, ≥1 member (`cwd`/`role`/`agent`/`tools: read-only`),
  `orchestrator` (`cwd`/`model`/`policy`), and a non-empty `artifacts` list. The output must be
  **valid-by-construction** against `validateCouncilConfig`.
- Seed bodies for `decisions.md` (`# Decisions` + note) and `open-questions.md`
  (`# Open Questions` + note) with the exact text from the action plan.

Use a literal template string (no new YAML-emitter dependency); members default to `read-only`
per CORE-COMPONENT-0007.

### Acceptance Criteria
- [ ] The generated `council.yaml` body parses (`yaml.parse`) and passes
      `validateCouncilConfig` with `members` as an array whose entry has an explicit `id`. (`C3`)
- [ ] The parsed config exposes typed policy fields: `orchestrator.policy.maxRounds === 5`,
      `requireProjectValidation === true`, `writeArtifacts === true`. (`C4`)
- [ ] The body includes `name` (= the input name), a non-empty `goal`, ≥1 member with
      `cwd`/`role`/`agent`/`tools: read-only`, an `orchestrator` with `cwd`/`model`/`policy`,
      and a non-empty `artifacts` list. (`C5`)
- [ ] Seed builders produce the exact `decisions.md` / `open-questions.md` bodies in the action
      plan. (`C6`)

### Test Coverage
- **TP-03** (generated YAML validates; members array w/ `id`).
- **TP-04** (round-trip via `loadCouncilConfig`; typed policy fields populated — the binding contract).
- **TP-05** (required fields present in the body).
- **TP-06** (seed file bodies exact).
- Content builders are pure → fully unit-coverable; contributes to ≥80% (CORE-COMPONENT-0009).

---

## Task TASK-03: Filesystem orchestration — atomic create, tree write, no-clobber, cleanup, success log

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-01, TASK-02
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0006, CORE-COMPONENT-0008, CORE-COMPONENT-0005, CORE-COMPONENT-0003

### Description
Compose TASK-01 (validation/guard) and TASK-02 (content) into the full `scaffoldCouncil` flow:

1. Validate `name` and compute `councilBase`/`councilDir` (TASK-01).
2. `mkdir(councilBase, { recursive: true })` (creates `council/` if absent; CORE-COMPONENT-0006
   mkdir-p) — **not** added to `created`.
3. `mkdir(councilDir, { recursive: false })` (atomic/exclusive). Map `EEXIST` →
   no-clobber `ConfigError` naming `councilDir`; this branch performs **no** deletion. (`E1`,`E2`)
4. Inside a `try` (dir is now ours): create `artifacts/` and `transcript/`; write
   `council.yaml`, `decisions.md`, `open-questions.md` (TASK-02 bodies). Track each created
   path into `created` in deterministic order.
5. On any failure in step 4: `rm(councilDir, { recursive: true, force: true })`, then rethrow a
   `ConfigError` (with `cause`) naming the `name`/path. Cleanup is unreachable for the
   no-clobber path, so a pre-existing workspace is never deleted (research R4). (`E5`)
6. On success: emit `council.init.created` via the injected/default logger with
   `{ name, councilDir, created: created.length }`; return `{ councilDir, created }`. No
   `console.log`. (`C7`)

### Acceptance Criteria
- [ ] Running against an empty `baseDir` produces exactly `council/<name>/` containing
      `council.yaml`, `artifacts/` (empty), `transcript/` (empty), `decisions.md`,
      `open-questions.md`; `council/` is created if absent. (`C2`)
- [ ] `created` lists the six workspace paths in the documented order; `councilDir` is returned. (`C2`)
- [ ] When `council/<name>/` already exists, the exclusive `mkdir` `EEXIST` is mapped to a
      `ConfigError` (`code === "CONFIG_ERROR"`) naming the path; no existing file is modified;
      the error propagates (non-zero exit via cli). (`E1`,`E2`)
- [ ] An injected post-create write failure causes the partial `council/<name>/` to be removed
      (`rm` recursive+force) before a `ConfigError` propagates; `council/` base is untouched. (`E5`)
- [ ] On success, `council.init.created` is emitted with the created path; no `console.log` is
      used. (`C7`)
- [ ] Cleanup never removes a directory the call did not create (no-clobber path does not `rm`). (`E5`)

### Test Coverage
- **TP-01** (happy-path exact tree + `created` array, temp `baseDir`).
- **TP-02** (`council/` base auto-created when absent; works when present).
- **TP-07** (success `council.init.created` event via captured logger; assert no `console.log`).
- **TP-08** (no-clobber: pre-existing dir w/ sentinel → `ConfigError`, sentinel untouched).
- **TP-11** (partial-failure cleanup via forced write error; dir removed, base intact).
- **TP-12** (no-clobber + cleanup messages name the path).
- Branch coverage for `EEXIST`-vs-other mkdir errors and success-vs-cleanup paths must keep the
  module ≥80% (CORE-COMPONENT-0009).

---

## Task TASK-04: Wire the thin `council init` commander action in `src/cli.ts`

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** TASK-03
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0005, CORE-COMPONENT-0008

### Description
Replace the `notImplemented("init")` body (`src/cli.ts:20-27`) with an `async` action that logs
`council.init` (`{ name }`), then `await scaffoldCouncil({ name, logger })`. Import
`scaffoldCouncil` from `./commands/init.js`. Leave the `notImplemented` helper in place for the
still-stubbed `add-member`/`run`/`continue` verbs. Let thrown `ConfigError`s propagate to the
existing top-level `program.parseAsync(...).catch(...)` (`src/cli.ts:59-64`), which logs
`council.error` and sets `process.exitCode = 1`. The action must contain **no** filesystem logic.

### Acceptance Criteria
- [ ] The `init` action no longer calls `notImplemented`; it delegates to `scaffoldCouncil`
      and contains no FS logic. (`C1`)
- [ ] On success the process exits `0`; on a thrown `ConfigError` it exits non-zero via the
      existing top-level catch (which logs `council.error`). (`C7`,`E1`)
- [ ] `scaffoldCouncil` is imported with a `.js` specifier (`./commands/init.js`); the shared
      `logger` is passed through. (CORE-COMPONENT-0005, CORE-COMPONENT-0009)
- [ ] `add-member`/`run`/`continue` actions remain unchanged. (regression guard)

### Test Coverage
- `src/cli.ts` is excluded from coverage (`vitest.config.ts`), so thinness is enforced by
  **code review** (no FS logic) and validated end-to-end by:
- **TP-13** (CLI smoke: `node dist/cli.js init <name>` in a temp cwd → exit 0, tree created;
  re-run → non-zero exit). Integration-level; runs after `./harness build`.
- Compilation/type-safety of the wiring is covered by `./harness build` in **TP-14**.

---

## Task TASK-05: Public exports (`src/index.ts`) and `LLM.txt` repo-map update

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** TASK-03
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0009

### Description
Two small surface updates:

1. **`src/index.ts`** — add `export * from "./commands/init.js";` (Q5: keep the public package
   surface consistent — every other module is barrel-exported).
2. **`LLM.txt`** — add a row for the new module file so the AI repo map stays accurate, e.g.
   `src/commands/init.ts   — council init scaffolder (scaffoldCouncil)`. Insert it near the
   other `src/...` rows, preserving the file's existing column alignment style.

### Acceptance Criteria
- [ ] `src/index.ts` re-exports `./commands/init.js` (named exports preserved). (Q5; CORE-COMPONENT-0009)
- [ ] `LLM.txt` contains a row naming `src/commands/init.ts` and describing the scaffolder. (`C8`)
- [ ] No other `LLM.txt` rows are reworded or reordered beyond the single addition. (`C8`)

### Test Coverage
- **TP-14** verification step greps `LLM.txt` for `src/commands/init.ts` (presence check) and
  runs `./harness lint`/`build` to confirm the new export compiles and type-checks.
- No new unit test is required for the barrel export (pure re-export); the import is exercised
  transitively by the module's own tests.

---

## Task TASK-06: Verification gate — coverage ≥80% and `./harness verify`

- **Status:** Planned
- **Complexity:** Low-Medium
- **Dependencies:** TASK-01, TASK-02, TASK-03, TASK-04, TASK-05
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0009

### Description
Run the full gate and confirm conventions. Use `./harness` as the first-choice surface:
`./harness lint`, `./harness test`, `./harness build`, and finally `./harness verify`
(lint + test + build). Confirm test conventions: tests are co-located `*.test.ts`, use `.js`
import specifiers, run under the `node` vitest environment, and overall coverage stays ≥80%
with `src/cli.ts` excluded (`vitest.config.ts`). Record any harness gap via
`./harness friction add` if a needed verb is missing/degraded.

### Acceptance Criteria
- [ ] `src/commands/init.test.ts` exists, co-located, `*.test.ts`, `.js` specifiers, `node`
      env. (`TS6`)
- [ ] Overall coverage ≥80% (lines/functions/branches/statements) with `src/cli.ts` excluded. (`TS6`)
- [ ] `./harness verify` reports verdict `pass` (lint + test + build). (`TS7`)
- [ ] `LLM.txt` lists `src/commands/init.ts`. (`C8`)

### Test Coverage
- **TP-14** (gate): `./harness verify` green; coverage threshold met; `LLM.txt` contains the
  new module row.
- This task aggregates the conventions/coverage AC `TS6` and the harness gate `TS7`.

---

## Acceptance-Criteria → Task Traceability

| AC | Description (short) | Task(s) |
|----|---------------------|---------|
| C1 | Replace stub; delegate to exported `scaffoldCouncil`; no inline FS in action | TASK-01, TASK-04 |
| C2 | Create `council/<name>/` tree (council.yaml, artifacts/, transcript/, 2 seeds) | TASK-03 |
| C3 | Generated `council.yaml` passes `validateCouncilConfig` (members array w/ `id`) | TASK-02 |
| C4 | `loadCouncilConfig` returns typed `policy.maxRounds/requireProjectValidation/writeArtifacts` | TASK-02 |
| C5 | Starter has name/goal/member/orchestrator/artifacts | TASK-02 |
| C6 | `decisions.md` + `open-questions.md` seed files | TASK-02, TASK-03 |
| C7 | Exit 0; `council.init.created` via shared logger; no `console.log` | TASK-03, TASK-04 |
| C8 | `LLM.txt` updated with new module file | TASK-05 |
| E1 | Existing dir → `ConfigError` naming path, non-zero, no mutation | TASK-03 |
| E2 | Atomic/exclusive create (`EEXIST` → `ConfigError`) | TASK-03 |
| E3 | Reject invalid names before any FS write | TASK-01 |
| E4 | Reject names resolving outside `council/` via `resolve`+`relative` | TASK-01 |
| E5 | Partial-failure cleanup of partial dir | TASK-03 |
| E6 | Human-actionable messages naming `name`/path | TASK-01, TASK-03 |
| TS1 | Unit tests vs temp `baseDir`, assert exact tree | TASK-03 |
| TS2 | Test asserts round-trip + populated typed policy | TASK-02 |
| TS3 | Test asserts re-run rejects, existing content untouched | TASK-03 |
| TS4 | Test asserts each invalid-name class rejected, no dir created | TASK-01 |
| TS5 | Partial-failure cleanup test | TASK-03 |
| TS6 | `.test.ts`, `.js` specifiers, `node` env, coverage ≥80% | TASK-06 |
| TS7 | `./harness verify` passes | TASK-06 |
