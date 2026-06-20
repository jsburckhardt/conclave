# Test Plan: Issue #6 — `council init`

Source: `project/issues/6/plan/01-action-plan.md`, `project/issues/6/plan/02-task-breakdown.md`.

## Conventions (apply to every unit test below)

- All unit tests live in the co-located file `src/commands/init.test.ts`
  (`*.test.ts`, organized with `describe`/`it`; CORE-COMPONENT-0009).
- Intra-project imports use **`.js`** specifiers (e.g. `import { scaffoldCouncil } from "./init.js"`).
- Tests run under the **`node`** vitest environment (`vitest.config.ts`).
- Filesystem tests use an isolated temp base dir —
  `baseDir = await mkdtemp(join(tmpdir(), "council-init-"))` — and clean up with
  `rm(baseDir, { recursive: true, force: true })`; **no** test touches the real
  `process.cwd()`. (Mirrors `src/store/artifact-store.test.ts`.)
- Overall coverage must stay **≥80%** (lines/functions/branches/statements) with `src/cli.ts`
  excluded from coverage (`vitest.config.ts`).
- The harness gate `./harness verify` (lint + test + build) is the final pass/fail signal.

---

## Test TP-01: Happy-path scaffolds the exact workspace tree

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Create a temp `baseDir` with no `council/` directory. Inject a capturing logger.

### Steps
1. `const res = await scaffoldCouncil({ name: "demo", baseDir, logger });`
2. `readdir(join(baseDir, "council", "demo"))` and sort the entries.
3. `readdir(join(baseDir, "council", "demo", "artifacts"))` and `.../transcript`.
4. Inspect `res.councilDir` and `res.created`.

### Expected Result
- Entries equal `["artifacts", "council.yaml", "decisions.md", "open-questions.md", "transcript"]`.
- `artifacts/` and `transcript/` are empty (`readdir` → `[]`); no `.gitkeep`.
- `res.councilDir === resolve(baseDir, "council", "demo")`.
- `res.created` deep-equals `[councilDir, .../artifacts, .../transcript, .../council.yaml,
  .../decisions.md, .../open-questions.md]` (documented order); `council/` base is **not** listed.
- Covers `C2`, `C6`, `TS1`.

---

## Test TP-02: `council/` base directory is created when absent and reused when present

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** Medium

### Setup
Two sub-cases sharing the temp-dir pattern.

### Steps
1. **Absent base:** fresh `baseDir` (no `council/`); call `scaffoldCouncil({ name: "a", baseDir })`.
2. **Pre-existing base:** `mkdir(join(baseDir, "council"))` first, then
   `scaffoldCouncil({ name: "b", baseDir })`.

### Expected Result
- Case 1: `council/` is created and `council/a/` is populated.
- Case 2: the existing `council/` is reused (no error) and `council/b/` is populated.
- Covers `C2`.

---

## Test TP-03: Generated `council.yaml` passes `validateCouncilConfig` with members as an array

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
Temp `baseDir`; scaffold `name: "demo"`.

### Steps
1. `const raw = await readFile(join(councilDir, "council.yaml"), "utf8");`
2. `const parsed = parse(raw);` (the `yaml` package).
3. `const cfg = validateCouncilConfig(parsed);`

### Expected Result
- `validateCouncilConfig` does **not** throw.
- `Array.isArray(parsed.members) === true` and `parsed.members[0].id` is a non-empty string.
- `cfg.members[0].tools === "read-only"`.
- Covers `C3`, `TS2`.

---

## Test TP-04: `loadCouncilConfig` round-trips and populates the typed policy fields (binding contract)

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
Temp `baseDir`; scaffold `name: "demo"`.

### Steps
1. `const cfg = await loadCouncilConfig(join(councilDir, "council.yaml"));`
2. Assert the typed policy fields and other required fields.

### Expected Result
- `cfg.orchestrator.policy.maxRounds === 5`.
- `cfg.orchestrator.policy.requireProjectValidation === true`.
- `cfg.orchestrator.policy.writeArtifacts === true`.
- `cfg.name === "demo"`, `cfg.goal` is a non-empty string, `cfg.members.length >= 1`,
  `cfg.orchestrator.cwd` is set, `cfg.artifacts.length >= 1`.
- This asserts the *populated typed fields*, not merely "does not throw" — the binding contract.
- Covers `C4`, `TS2`.

---

## Test TP-05: Starter `council.yaml` includes all required fields

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** Medium

### Setup
Temp `baseDir`; scaffold `name: "demo"`; load via `loadCouncilConfig` (and/or parse raw).

### Steps
1. Inspect the loaded `CouncilConfig` (and raw parse for `agent`/`model`).

### Expected Result
- `name` equals the input, `goal` present; member has `cwd`, `role`, `agent`, `tools: read-only`;
  `orchestrator` has `cwd`, `model`, `policy`; `artifacts` is a non-empty list.
- Covers `C5`.

---

## Test TP-06: Seed files are created with the expected content

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** Medium

### Setup
Temp `baseDir`; scaffold `name: "demo"`.

### Steps
1. `readFile(join(councilDir, "decisions.md"), "utf8")`.
2. `readFile(join(councilDir, "open-questions.md"), "utf8")`.

### Expected Result
- `decisions.md` begins with `# Decisions` and contains the seed note.
- `open-questions.md` begins with `# Open Questions` and contains the seed note.
- Covers `C6`.

---

## Test TP-07: Success emits `council.init.created`; no `console.log`

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Temp `baseDir`. Provide a capturing logger (records `{ message, fields }` per call). Spy on
`console.log` with `vi.spyOn(console, "log")`.

### Steps
1. `await scaffoldCouncil({ name: "demo", baseDir, logger });`
2. Inspect captured log records and the `console.log` spy.

### Expected Result
- Exactly one `council.init.created` record is captured, with fields including the created path
  (`councilDir`) and a `created` count/list.
- `console.log` was **not** called.
- Covers `C7` (and contributes to CORE-COMPONENT-0005 compliance).

---

## Test TP-08: Existing council directory is not clobbered (`EEXIST` → `ConfigError`, content untouched)

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Temp `baseDir`. Pre-create `council/demo/` and write a sentinel file
`council/demo/sentinel.txt` with content `"keep"`.

### Steps
1. `await expect(scaffoldCouncil({ name: "demo", baseDir })).rejects` to be a `ConfigError`.
2. Assert `err.code === "CONFIG_ERROR"` and the message names the path.
3. `readFile(join(baseDir, "council", "demo", "sentinel.txt"), "utf8")`.

### Expected Result
- Rejection is a `ConfigError` (`code === "CONFIG_ERROR"`) naming `council/demo`.
- `sentinel.txt` still exists and equals `"keep"` (no existing file modified / no clobber).
- The exclusive `mkdir` (`recursive: false`) `EEXIST` path is what triggers the rejection
  (atomic/exclusive), and cleanup did **not** run (sentinel survived).
- Covers `E1`, `E2`, `TS3`.

---

## Test TP-09: Each invalid-name class is rejected before any filesystem write

- **Type:** Unit
- **Task:** TASK-01
- **Priority:** High

### Setup
Temp `baseDir`. Table of invalid names:
`["", "   ", ".", "..", "a/b", "a\\b", "a\u0000b"]`.

### Steps
1. For each name: `await expect(scaffoldCouncil({ name, baseDir })).rejects` → `ConfigError`.
2. After each rejection, assert no `council/<name>` directory exists; assert the `council/`
   base was not polluted with a stray entry for that name.

### Expected Result
- Every class rejects with `ConfigError` (`code === "CONFIG_ERROR"`).
- No directory is created for any rejected name (rejection happens before any FS write).
- Covers `E3`, `TS4`.

---

## Test TP-10: Traversal guard via `resolve`+`relative` (not string matching alone)

- **Type:** Unit
- **Task:** TASK-01
- **Priority:** High

### Setup
Temp `baseDir`.

### Steps
1. **Positive invariant:** for a set of valid names (`"demo"`, `"a.b_c-1"`), scaffold and assert
   `relative(resolve(baseDir, "council"), res.councilDir) === name` and does not start with `..`
   (the resolved dir is strictly inside `council/`).
2. **Backstop:** `await expect(scaffoldCouncil({ name: "..", baseDir })).rejects` → `ConfigError`;
   assert nothing was created at `resolve(baseDir, "council", "..")` (i.e. `baseDir` itself gained
   no council artifacts).

### Expected Result
- Every accepted name resolves strictly within the `council/` base (guard property holds).
- `".."` is rejected by the validator/guard backstop; no directory escapes `council/`.
- Covers `E4`.

---

## Test TP-11: Partial-failure cleanup removes the partially-created directory

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Temp `baseDir`. Force a write error that occurs **after** the exclusive `mkdir(councilDir)`
succeeds — e.g. partial-mock `node:fs/promises` so that one post-create call (such as the
`writeFile` for `decisions.md`, or the `mkdir` for `transcript/`) rejects **once**, while
`mkdir(councilBase)`, the exclusive `mkdir(councilDir)`, and `rm` delegate to the real
implementation so cleanup genuinely removes the directory.

### Steps
1. `await expect(scaffoldCouncil({ name: "demo", baseDir })).rejects` → `ConfigError` (with `cause`).
2. Assert `council/demo/` no longer exists (`stat` throws `ENOENT` / `existsSync` is `false`).
3. Assert the `council/` base directory still exists (cleanup removed only `councilDir`).

### Expected Result
- The injected failure propagates as a `ConfigError` whose `cause` is the underlying error.
- The partial `council/demo/` directory is removed (`rm` recursive + force), so a corrected
  re-run is not blocked.
- The `council/` base is untouched — cleanup removed only the directory this call created.
- Covers `E5`, `TS5`.

---

## Test TP-12: Error messages are human-actionable and name the offending `name`/path

- **Type:** Unit
- **Task:** TASK-01, TASK-03
- **Priority:** Medium

### Setup
Reuse fixtures from TP-08 (no-clobber), TP-09 (invalid name), and TP-11 (partial failure).

### Steps
1. Capture each thrown `ConfigError.message`.
2. Assert each message references the offending `name` or the council path.

### Expected Result
- Invalid-name error names the rejected `name`.
- No-clobber error names the `council/<name>` path.
- Partial-failure error names the `name`/path and preserves `cause`.
- All are `ConfigError` (`code === "CONFIG_ERROR"`).
- Covers `E6`.

---

## Test TP-13: CLI smoke — `council init` end-to-end exit codes and tree

- **Type:** Integration
- **Task:** TASK-04
- **Priority:** Medium

### Setup
Run after `./harness build`. Use a temp working directory as `cwd`. Invoke the built CLI via
`child_process` (e.g. `execFile(process.execPath, [join(repo, "dist/cli.js"), "init", "demo"], { cwd: tmpCwd })`).

### Steps
1. First invocation of `init demo` in the empty temp cwd.
2. Second invocation of `init demo` in the same cwd (now occupied).

### Expected Result
- First run: exit code `0`; `council/demo/` tree exists under the temp cwd; a JSON
  `council.init.created` line is emitted on stdout.
- Second run: non-zero exit; a `council.error` JSON line is emitted on stderr; the existing
  workspace is unchanged.
- Confirms `C1` (thin action delegates), `C7` (exit/log), and `E1` (non-zero on clobber)
  end-to-end. (Optional if a hermetic spawn is impractical in CI; the behaviors are otherwise
  covered by TP-07/TP-08 at the unit level and code review of the action.)

---

## Test TP-14: Verification gate — coverage ≥80%, `LLM.txt` updated, `./harness verify` green

- **Type:** Gate / Verification
- **Task:** TASK-06 (and TASK-05 for `LLM.txt`)
- **Priority:** High

### Setup
Clean working tree with all tasks implemented.

### Steps
1. `./harness lint` (ESLint + Prettier check + typecheck).
2. `./harness test` (vitest with coverage).
3. `./harness build` (`tsc`).
4. `./harness verify` (lint + test + build aggregate).
5. `grep "src/commands/init.ts" LLM.txt`.

### Expected Result
- `./harness verify` returns verdict `pass`.
- Coverage report shows overall ≥80% (lines/functions/branches/statements) with `src/cli.ts`
  excluded; `src/commands/init.ts` is exercised by `src/commands/init.test.ts`.
- Tests are co-located `*.test.ts`, use `.js` specifiers, and run under the `node` env.
- `LLM.txt` contains a row naming `src/commands/init.ts`.
- If any needed harness verb is missing/degraded, a gap is recorded via `./harness friction add`.
- Covers `TS6`, `TS7`, `C8`.

---

## Acceptance-Criteria → Test Traceability

| AC | Description (short) | Test(s) |
|----|---------------------|---------|
| C1 | Replace stub; delegate to exported `scaffoldCouncil`; no inline FS | TP-13 (+ all unit tests import the seam; code review) |
| C2 | Create `council/<name>/` tree | TP-01, TP-02 |
| C3 | Generated `council.yaml` passes `validateCouncilConfig` (members array w/ `id`) | TP-03 |
| C4 | Typed `policy.maxRounds/requireProjectValidation/writeArtifacts` populated | TP-04 |
| C5 | Starter has name/goal/member/orchestrator/artifacts | TP-05 |
| C6 | `decisions.md` + `open-questions.md` seed files | TP-01, TP-06 |
| C7 | Exit 0; `council.init.created`; no `console.log` | TP-07, TP-13 |
| C8 | `LLM.txt` updated with new module file | TP-14 |
| E1 | Existing dir → `ConfigError` naming path, non-zero, no mutation | TP-08, TP-13 |
| E2 | Atomic/exclusive create (`EEXIST` → `ConfigError`) | TP-08 |
| E3 | Reject invalid names before any FS write | TP-09 |
| E4 | Reject names resolving outside `council/` via `resolve`+`relative` | TP-10 |
| E5 | Partial-failure cleanup of partial dir | TP-11 |
| E6 | Human-actionable messages naming `name`/path | TP-12 |
| TS1 | Unit tests vs temp `baseDir`, assert exact tree | TP-01 |
| TS2 | Round-trip + populated typed policy | TP-03, TP-04 |
| TS3 | Re-run rejects, existing content untouched | TP-08 |
| TS4 | Each invalid-name class rejected, no dir created | TP-09 |
| TS5 | Partial-failure cleanup | TP-11 |
| TS6 | `.test.ts`, `.js` specifiers, `node` env, coverage ≥80% | TP-14 (+ all unit tests) |
| TS7 | `./harness verify` passes | TP-14 |
