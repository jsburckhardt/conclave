# Test Plan: Issue #7 — `council add-member`

Source: `project/issues/7/plan/01-action-plan.md`, `project/issues/7/plan/02-task-breakdown.md`.

## Conventions (apply to every test below)

- Unit tests live in co-located files: `src/config/add-member.test.ts` (module logic),
  `src/config/council-config.test.ts` (extend for `resolveCouncilConfigPath`), and
  `src/cli-program.test.ts` (in-process CLI). All use `describe`/`it` (CORE-COMPONENT-0009).
- Intra-project imports use **`.js`** specifiers (e.g. `import { addMember } from "./add-member.js"`).
- Tests run under the **`node`** vitest environment (`vitest.config.ts`).
- Filesystem tests use an isolated temp base dir —
  `baseDir = await mkdtemp(join(tmpdir(), "council-add-member-"))` — and clean up with
  `rm(baseDir, { recursive: true, force: true })`; **no** test touches the real `process.cwd()`.
  A `council/<name>/council.yaml` fixture is written directly (the issue's stated approach until
  `init` is merged on this branch). Mirrors `src/commands/init.test.ts`.
- A **capturing logger** (`{ message, fields }[]`) is injected to assert log records; tests spy on
  `console.log` to prove it is never called (CORE-COMPONENT-0005).
- The partial `vi.mock("node:fs/promises", async (importOriginal) => ({ ...actual, writeFile:
  vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }))` pattern forces a post-parse write/rename
  failure while every other call delegates to the real implementation (mirrors `init.test.ts`).
- A helper `expectConfigError(promise)` asserts the rejection is a `ConfigError` with
  `code === "CONFIG_ERROR"` and returns it for message assertions.
- CLI-behavior tests reset `process.exitCode = 0` in `beforeEach`/`afterEach` and call
  `main(["node", "council", ...args], { logger, baseDir })` in-process (commander needs the two
  leading argv placeholders); they assert `process.exitCode` rather than spawning a process.
- A `valid council.yaml` fixture used throughout contains a top comment, an inline member comment,
  an unknown forward-compat key (`unknownKey: keepme`), one pre-existing member, and an
  `orchestrator` section — so preservation can be asserted.
- Overall coverage must stay **≥80%** (lines/functions/branches/statements) with `src/cli.ts`
  excluded. `./harness verify` is the final pass/fail signal.

---

## Test TP-01: Happy path — add a member, then re-read via `loadCouncilConfig`

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; write a valid `council/demo/council.yaml` fixture with one pre-existing member
(`id: alice`). Inject a capturing logger.

### Steps
1. `await addMember({ council: "demo", memberId: "bob", cwd: "../bob", role: "Reviewer", baseDir, logger });`
2. `const cfg = await loadCouncilConfig(resolveCouncilConfigPath("demo", baseDir));`

### Expected Result
- `cfg.members` has length 2; the new entry has `id === "bob"`, `cwd === "../bob"`,
  `role === "Reviewer"`, `tools === "read-only"`.
- The pre-existing `alice` member is still present and unchanged.
- Covers `C3`, `C5`, `TS1`.

---

## Test TP-02: `--tools` default is `read-only`; explicit `read-write` is preserved

- **Type:** Unit
- **Task:** TASK-02, TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; fresh valid fixture per sub-case.

### Steps
1. Add `memberId: "r1"` **omitting** `tools`; re-read.
2. Add `memberId: "r2"` with `tools: "read-write"`; re-read.

### Expected Result
- `r1.tools === "read-only"` (default applied, not coerced silently by the validator — set by
  `add-member`).
- `r2.tools === "read-write"` (explicit value preserved).
- Covers `C2`, `TS3`.

---

## Test TP-03: Duplicate `memberId` (case-sensitive, trimmed) is rejected; file unchanged

- **Type:** Unit
- **Task:** TASK-02, TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; fixture with pre-existing `id: alice`. Capture original file bytes
(`readFile(path, "utf8")`). Also build a `parseDocument` fixture for the pure `applyAddMember` path.

### Steps
1. `await expectConfigError(addMember({ council: "demo", memberId: "alice", cwd: ".", role: "r", baseDir }))`.
2. Repeat with `memberId: " alice "` (trimmed comparison).
3. Repeat with `memberId: "Alice"` → **accepted** (case-sensitive, so not a duplicate).
4. Pure path: `applyAddMember(doc, { id: "alice", ... })` throws `ConfigError`.
5. Re-read the file bytes after each rejection.

### Expected Result
- `"alice"` and `" alice "` reject with `ConfigError` naming the id; the file is **byte-for-byte
  unchanged** after each.
- `"Alice"` is added successfully (case-sensitive comparison).
- `applyAddMember` throws on the duplicate and does not mutate the Document.
- Covers `E2`, `TS2`, `C10`.

---

## Test TP-04: Invalid `--tools` is rejected (not silently coerced)

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture. Capture original bytes.

### Steps
1. For each of `"garbage-mode"`, `"READ-ONLY"`, `"readwrite"`, `""`:
   `await expectConfigError(addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", tools: <bad>, baseDir }))`.
2. Re-read the file bytes.

### Expected Result
- Each invalid value rejects with a `ConfigError` whose message names the `tools` field and the
  allowed values.
- The file is unchanged (no coercion-to-`read-only`, no write).
- Covers `E3`, `TS5`.

---

## Test TP-05: Empty/whitespace/non-string required fields are rejected with field-naming messages

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture.

### Steps
1. `memberId`: `""`, `"   "` → reject.
2. `cwd`: `""`, `"   "` → reject.
3. `role`: `""`, `"   "` → reject.
4. (Type-guard) a non-string passed where a string is required → reject.

### Expected Result
- Every case rejects with a `ConfigError` whose message **names the offending field**
  (`memberId`/`cwd`/`role`).
- No file write occurs.
- Covers `E4`, `TS6`.

---

## Test TP-06: `memberId` charset `^[A-Za-z0-9][A-Za-z0-9._-]*$` is enforced

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture.

### Steps
1. Reject table: `"."`, `".."`, `".hidden"`, `"-lead"`, `"_lead"`, `"a b"`, `"a/b"`, `"a@b"`, `""`.
2. Accept table: `"a"`, `"a1"`, `"a.b_c-1"`, `"Alice"` (sanity — these add successfully).

### Expected Result
- Every reject-table value throws `ConfigError` naming `memberId` (and the charset rule); no write.
- Every accept-table value is appended successfully (must start alphanumeric).
- Specifically guards against `.`/`..`-style ids unsafe as the `"<councilId>/<memberId>"` session
  path segment (CORE-COMPONENT-0004).
- Covers `E5`, `TS6`.

---

## Test TP-07: Missing council directory / missing `council.yaml` → `ConfigError`

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir` with **no** `council/` directory (and a sub-case with `council/demo/` present but
no `council.yaml`).

### Steps
1. `const err = await expectConfigError(addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", baseDir }));`
2. Inspect `err.message` and the filesystem.

### Expected Result
- Rejection is a `ConfigError` (`code === "CONFIG_ERROR"`) naming the resolved path.
- Nothing is created (no `council/`, no `council.yaml`); nothing is corrupted.
- Covers `E1`, `TS4`.

---

## Test TP-08: Malformed (unparseable) YAML → `ConfigError`; file not overwritten

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; write `council/demo/council.yaml` with **unparseable** YAML (e.g. an unclosed
flow map `members: [` or a bad tab/indent). Capture original bytes.

### Steps
1. `await expectConfigError(addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", baseDir }))`.
2. Re-read the file bytes.

### Expected Result
- Rejection is a `ConfigError` (parse failure, `cause` preserved).
- The file is byte-for-byte unchanged (no overwrite, no temp left behind).
- Covers `E6`, `TS7`, `C10`.

---

## Test TP-09: Parseable-but-already-invalid `council.yaml` → `ConfigError`; not overwritten

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; write a `council.yaml` that **parses** but **fails** `validateCouncilConfig`
(e.g. missing `orchestrator`, or `members` not an array). Capture original bytes.

### Steps
1. `await expectConfigError(addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", baseDir }))`.
2. Re-read the file bytes.

### Expected Result
- Rejection is a `ConfigError` raised by the **re-validation** step (the edited document still
  fails `validateCouncilConfig`) — adding even a valid member is blocked.
- The file is byte-for-byte unchanged (write only happens after validation passes).
- Covers `E7`, `TS7`, `C5`, `C10`.

---

## Test TP-10: Round-trip preservation — comments, unknown keys, orchestrator, pre-existing members

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; fixture containing: a top `# comment`, an inline comment on the pre-existing
member, `unknownKey: keepme` at the root, the `orchestrator` section, and `members: [{ id: alice }]`.

### Steps
1. `await addMember({ council: "demo", memberId: "bob", cwd: "../bob", role: "Reviewer", baseDir });`
2. `const raw = await readFile(path, "utf8");`
3. `const cfg = await loadCouncilConfig(path);`

### Expected Result
- `raw` still contains the top comment, the inline member comment, `unknownKey: keepme`, and the
  full `orchestrator` block (proves `String(doc)` was persisted, not the normalized output).
- `cfg.members` contains both `alice` and `bob`.
- The pre-existing member's fields are unchanged; key order is preserved.
- Covers `C4`, `C7`, `TS8`.

---

## Test TP-11: Atomic write — same-dir temp + `rename`, no leftover temp file (success)

- **Type:** Unit
- **Task:** TASK-03, TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture. Optionally spy on `rename`/`writeFile` (delegating to real impls)
to assert a same-directory temp path was used.

### Steps
1. `await addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir });`
2. `const entries = await readdir(join(baseDir, "council", "demo"));`

### Expected Result
- The add succeeds and `entries` contains `council.yaml` and **no** `*.tmp` file.
- If spied: the temp path passed to `writeFile`/`rename` is in the **same directory** as
  `council.yaml` and matches the unique `.<base>.<pid>.<uuid>.tmp` shape.
- Covers `C8`.

---

## Test TP-12: Failure atomicity — injected write/rename error leaves the file unchanged, no temp

- **Type:** Unit
- **Task:** TASK-03, TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture. Capture original bytes. Use the partial `node:fs/promises` mock to
make **`rename`** (and a sub-case **`writeFile`** of the temp) reject **once**, while `readFile`,
`rm`, and `readdir` delegate to real implementations.

### Steps
1. `const err = await expectConfigError(addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir }));`
2. Re-read the file bytes; `readdir` the directory.

### Expected Result
- The injected failure propagates as a `ConfigError` (with `cause`).
- The original `council.yaml` is **byte-for-byte unchanged**.
- No `*.tmp` file remains (cleanup-on-error ran).
- Covers `C8`, `C10`.

---

## Test TP-13: Sequential and concurrent adds leave a valid, uncorrupted file

- **Type:** Unit
- **Task:** TASK-03, TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture (real `fs`, no mocks).

### Steps
1. **Sequential:** `for (const id of ["m1","m2","m3"]) await addMember({ council:"demo", memberId:id, cwd:".", role:"r", baseDir });`
   then `loadCouncilConfig`.
2. **Concurrent:** fresh fixture; `await Promise.all([...["c1","c2","c3"].map(id => addMember({ council:"demo", memberId:id, cwd:".", role:"r", baseDir }))])`;
   then `loadCouncilConfig` and `readdir`.

### Expected Result
- Sequential: all three members are present (no lost updates when serialized).
- Concurrent: `loadCouncilConfig` succeeds (file is **valid and uncorrupted**), **no** `*.tmp`
  file remains, and **at least one** new member is present. (Last-writer-wins may drop some
  concurrent members — the **documented v0 single-writer limitation**, research R1; the test
  asserts validity/no-corruption, **not** that all survive.)
- Covers `E9`, `TS9`.

---

## Test TP-14: Traversal guard — `<council>` cannot escape the council root

- **Type:** Unit
- **Task:** TASK-01
- **Priority:** High

### Setup
Temp `baseDir`.

### Steps
1. For each of `".."`, `"../../etc"`, `"a/../.."`, `"../sibling"`:
   `expect(() => resolveCouncilConfigPath(name, baseDir)).toThrow(ConfigError)` (and via
   `addMember`, `await expectConfigError(...)`).
2. Positive invariant: for `"demo"`, `"a.b_c-1"`,
   `relative(resolve(baseDir, "council"), dirname(resolveCouncilConfigPath(name, baseDir))) === name`.

### Expected Result
- Every escaping `<council>` rejects with `ConfigError` naming the value (via `resolve`+`relative`,
  not string-matching alone); no file is created at any escaped location.
- Every accepted name resolves strictly inside `council/`.
- Covers `E8`, `C3`.

---

## Test TP-15: `resolveCouncilConfigPath` returns `council/<council>/council.yaml`

- **Type:** Unit
- **Task:** TASK-01
- **Priority:** Medium

### Setup
Temp `baseDir`.

### Steps
1. `const p = resolveCouncilConfigPath("demo", baseDir);`
2. Sub-case without `baseDir`: assert it resolves under `process.cwd()`.

### Expected Result
- `p === resolve(baseDir, "council", "demo", "council.yaml")`.
- With `baseDir` omitted, the path is anchored at `process.cwd()`.
- The function performs no filesystem IO (callable without any `council/` directory existing).
- Covers `C3`.

---

## Test TP-16: Entry and success logs are emitted; `console.log` is never called

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir`; valid fixture. Inject a capturing logger; `vi.spyOn(console, "log")`.

### Steps
1. `await addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", tools: "read-write", baseDir, logger });`
2. Inspect captured records and the `console.log` spy.

### Expected Result
- Exactly one `council.add-member` record with `{ council: "demo", memberId: "bob" }` (entry).
- Exactly one `council.add-member.succeeded` record with `{ council: "demo", memberId: "bob",
  tools: "read-write" }`.
- `console.log` was **not** called.
- Covers `C9`.

---

## Test TP-17: Failure log carries the `ConfigError` `code` plus `council` and `memberId`

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
Temp `baseDir` with **no** `council.yaml` (forces a failure). Inject a capturing logger.

### Steps
1. `await expectConfigError(addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir, logger }));`
2. Inspect captured records.

### Expected Result
- A `council.add-member.failed` record is captured with fields `{ council: "demo", memberId:
  "bob", code: "CONFIG_ERROR" }`, emitted **before** the error propagates.
- Covers `C9`, `C10`.

---

## Test TP-18: CLI-behavior via in-process `main(argv, deps)` — exit codes and structured logs

- **Type:** Integration (in-process CLI)
- **Task:** TASK-05
- **Priority:** High

### Setup
Temp `baseDir`. Inject a capturing logger and `baseDir` via `deps`. Reset `process.exitCode = 0`
around each case. For the success case, write a valid `council/demo/council.yaml` fixture.

### Steps
1. **Failure:** `await main(["node","council","add-member","missing","bob","--cwd",".","--role","r"], { logger, baseDir });`
   (no `council/missing/council.yaml`).
2. **Success:** `await main(["node","council","add-member","demo","bob","--cwd",".","--role","r"], { logger, baseDir });`

### Expected Result
- Failure: `process.exitCode` is non-zero; a structured error record is emitted carrying the
  `code` (the `council.add-member.failed` record with `code: "CONFIG_ERROR"`, and/or the
  top-level `council.error`). The file (if any) is unchanged.
- Success: `process.exitCode` is `0`; both a start (`council.add-member`) and a success
  (`council.add-member.succeeded`) record are emitted; `council/demo/council.yaml` gains `bob`.
- Covers `C1`, `C9`, `C10`, `TS10`.

---

## Test TP-19: CLI smoke for `init`/`run`/`continue` via `main` (coverage of moved actions)

- **Type:** Integration (in-process CLI)
- **Task:** TASK-05
- **Priority:** Medium

### Setup
Temp `baseDir`; inject logger + `baseDir`. Reset `process.exitCode` around each case. For `run`,
write a valid config and pass `--config <path>`.

### Steps
1. `await main(["node","council","init","smoke"], { logger, baseDir });`
2. `await main(["node","council","run","smoke","--config", validConfigPath], { logger, baseDir });`
3. `await main(["node","council","continue","smoke"], { logger, baseDir });`

### Expected Result
- `init` scaffolds `council/smoke/` and exits `0` (delegates to `scaffoldCouncil`).
- `run` loads the config, logs `council.run`, then reports not-implemented (exit non-zero via
  `notImplemented`) — behavior unchanged by the move.
- `continue` logs `council.continue` and reports not-implemented — behavior unchanged.
- Keeps `src/cli-program.ts` ≥80% across functions/branches (the moved actions are exercised).
- Regression guard for `C1` (other commands unaffected).

---

## Test TP-20: Documentation and public exports updated

- **Type:** Gate / Documentation
- **Task:** TASK-06
- **Priority:** Medium

### Setup
Working tree with TASK-06 applied.

### Steps
1. `grep "src/config/add-member.ts" LLM.txt` and `grep "src/cli-program.ts" LLM.txt`.
2. `grep -i "single-writer\|concurren\|limitation" README.md`.
3. Type-check the barrel: `./harness build` (or `npm run typecheck`) resolves
   `addMember`/`applyAddMember`/`AddMemberOptions`/`resolveCouncilConfigPath` from `conclave`.
4. After build, `node dist/cli.js add-member --help`.

### Expected Result
- `LLM.txt` contains rows for both new modules; no unrelated rows reworded.
- `README.md` documents the `add-member` flags and a Limitations subsection covering the
  single-writer concurrency limitation and the `run`/`continue` reconciliation follow-up.
- The public surface re-exports compile and type-check.
- `add-member --help` lists `--cwd`/`--role`/`--agent`/`--tools` (default `read-only`).
- Covers `C2` (help), `E9` (documented limitation), documentation criteria.

---

## Test TP-21: Verification gate — coverage ≥80%, `./harness verify` green

- **Type:** Gate / Verification
- **Task:** TASK-07
- **Priority:** High

### Setup
Clean working tree with all tasks implemented.

### Steps
1. `./harness lint` (ESLint + Prettier check + typecheck).
2. `./harness test` (vitest with coverage).
3. `./harness build` (`tsc`).
4. `./harness verify` (lint + test + build aggregate).

### Expected Result
- `./harness verify` returns verdict `pass`.
- Coverage report shows overall ≥80% (lines/functions/branches/statements) with `src/cli.ts`
  excluded; `src/config/add-member.ts`, `src/cli-program.ts`, and `resolveCouncilConfigPath` are
  exercised.
- New tests are co-located `*.test.ts`, use `.js` specifiers, and run under the `node` env.
- If any needed harness verb is missing/`degraded`/`unknown`, a gap is recorded via
  `./harness friction add` and the wrapped npm script is used as fallback.
- Covers `TS11`.

---

## Acceptance-Criteria → Test Traceability

| AC | Description (short) | Test(s) |
|----|---------------------|---------|
| C1 | Replace stub; thin action delegates to `addMember` | TP-18, TP-19 (+ review) |
| C2 | `--cwd`/`--role`/`--agent`/`--tools`; default `read-only` | TP-02, TP-20 |
| C3 | Append to `council/<council>/council.yaml` via `resolveCouncilConfigPath` | TP-01, TP-14, TP-15 |
| C4 | `yaml` Document API preserves comments/order/orchestrator | TP-10 |
| C5 | Re-validate; write only on pass | TP-01, TP-09 |
| C6 | Edit logic in `src/config/add-member.ts`, not the action | TP-01..TP-17 (import the module); review |
| C7 | Pre-existing members/orchestrator/unknown keys survive | TP-10 |
| C8 | Atomic write: unique same-dir temp + `rename` + cleanup | TP-11, TP-12 |
| C9 | Entry/success/failure logs; failure carries `code` | TP-16, TP-17, TP-18 |
| C10 | Non-zero exit on failure; file byte-for-byte unchanged | TP-03, TP-08, TP-09, TP-12, TP-17, TP-18 |
| E1 | Missing dir/file → `ConfigError`; nothing created | TP-07 |
| E2 | Duplicate `memberId` (case-sensitive, trimmed) rejected | TP-03 |
| E3 | Invalid `--tools` rejected (not coerced) | TP-04 |
| E4 | Empty/whitespace/non-string fields rejected | TP-05 |
| E5 | `memberId` charset enforced | TP-06 |
| E6 | Malformed YAML → `ConfigError`; not overwritten | TP-08 |
| E7 | Parseable-but-invalid → `ConfigError`; not overwritten | TP-09 |
| E8 | `<council>` cannot traverse outside the council root | TP-14 |
| E9 | Concurrent adds cannot corrupt; limitation documented | TP-13, TP-20 |
| TS1 | Add then re-read via `loadCouncilConfig` | TP-01 |
| TS2 | Duplicate rejected; file unchanged | TP-03 |
| TS3 | Default `read-only`; explicit `read-write` preserved | TP-02 |
| TS4 | Missing council/`council.yaml` → `ConfigError` | TP-07 |
| TS5 | Invalid `--tools` rejected | TP-04 |
| TS6 | Missing/whitespace fields + charset-invalid `memberId` | TP-05, TP-06 |
| TS7 | Malformed + parseable-but-invalid YAML → `ConfigError` | TP-08, TP-09 |
| TS8 | Comments/unknown keys/orchestrator/pre-existing survive | TP-10 |
| TS9 | Sequential + concurrent adds → valid, uncorrupted file | TP-13 |
| TS10 | In-process CLI exit codes + structured logs | TP-18 |
| TS11 | Co-located `*.test.ts`, `.js` specifiers, coverage ≥80% | TP-21 (+ all unit tests) |
