import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { addMember, applyAddMember } from "./add-member.js";
import { loadCouncilConfig, resolveCouncilConfigPath } from "./council-config.js";
import { ConfigError } from "../errors.js";
import type { LogFields, Logger } from "../logging/logger.js";

// Mock ONLY `writeFile`, `rename`, and `rm` so the atomicity tests can force a
// post-parse write/rename failure (and a cleanup failure) while every other
// function (mkdir/readFile/readdir/stat/mkdtemp) delegates to the real
// implementation. By default the spies delegate to the real impls, so normal
// tests behave normally. Mirrors the partial-mock pattern in
// `src/commands/init.test.ts`.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

interface CapturedLog {
  message: string;
  fields?: LogFields;
}

function createCapturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const record = (message: string, fields?: LogFields): void => {
    records.push({ message, fields });
  };
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    records,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  const err = await promise.then(
    () => {
      throw new Error("expected addMember to reject, but it resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).code).toBe("CONFIG_ERROR");
  return err as ConfigError;
}

// A valid council.yaml fixture with: a top comment, an inline member comment, an
// unknown forward-compat key, one pre-existing member (alice), and an
// orchestrator section — so preservation can be asserted (TP-10).
const VALID_FIXTURE = `# Council configuration — keep this comment.
name: demo
goal: Ship the thing
unknownKey: keepme
members:
  - id: alice # founding member — keep this inline comment
    cwd: ../alice
    role: Lead
    agent: lead-agent
    tools: read-write
orchestrator:
  cwd: .
  model: gpt-5
  policy:
    maxRounds: 5
artifacts:
  - artifacts/backlog.md
`;

describe("addMember", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "council-add-member-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeFixture(council: string, body = VALID_FIXTURE): Promise<string> {
    const dir = join(baseDir, "council", council);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "council.yaml");
    await writeFile(path, body, "utf8");
    return path;
  }

  function tempFiles(council: string): Promise<string[]> {
    return readdir(join(baseDir, "council", council)).then((entries) =>
      entries.filter((e) => e.endsWith(".tmp")),
    );
  }

  // TP-01 — happy path: add a member, then re-read via loadCouncilConfig.
  it("adds a member and re-reads it via loadCouncilConfig (TP-01)", async () => {
    await writeFixture("demo");
    const { logger } = createCapturingLogger();
    await addMember({
      council: "demo",
      memberId: "bob",
      cwd: "../bob",
      role: "Reviewer",
      baseDir,
      logger,
    });

    const cfg = await loadCouncilConfig(resolveCouncilConfigPath("demo", baseDir));
    expect(cfg.members).toHaveLength(2);
    expect(cfg.members.find((m) => m.id === "bob")).toMatchObject({
      id: "bob",
      cwd: "../bob",
      role: "Reviewer",
      tools: "read-only",
    });
    // Pre-existing alice survives unchanged.
    expect(cfg.members.find((m) => m.id === "alice")).toMatchObject({
      id: "alice",
      cwd: "../alice",
      role: "Lead",
      tools: "read-write",
    });
  });

  // TP-02 — --tools default is read-only; explicit read-write preserved.
  it("defaults --tools to read-only and preserves explicit read-write (TP-02)", async () => {
    const path = await writeFixture("demo");
    await addMember({ council: "demo", memberId: "r1", cwd: ".", role: "r", baseDir });
    await addMember({
      council: "demo",
      memberId: "r2",
      cwd: ".",
      role: "r",
      tools: "read-write",
      baseDir,
    });
    const cfg = await loadCouncilConfig(path);
    expect(cfg.members.find((m) => m.id === "r1")?.tools).toBe("read-only");
    expect(cfg.members.find((m) => m.id === "r2")?.tools).toBe("read-write");
  });

  // Optional --agent is stored (and trimmed) when provided.
  it("stores an optional --agent when provided and trims it", async () => {
    const path = await writeFixture("demo");
    await addMember({
      council: "demo",
      memberId: "bob",
      cwd: ".",
      role: "r",
      agent: "  rev-agent  ",
      baseDir,
    });
    const cfg = await loadCouncilConfig(path);
    expect(cfg.members.find((m) => m.id === "bob")?.agent).toBe("rev-agent");
  });

  // TP-03 — duplicate memberId (case-sensitive, trimmed) rejected; file unchanged.
  it("rejects a duplicate memberId (case-sensitive, trimmed); file unchanged (TP-03)", async () => {
    const path = await writeFixture("demo");
    const before = await readFile(path, "utf8");

    const dupErr = await expectConfigError(
      addMember({ council: "demo", memberId: "alice", cwd: ".", role: "r", baseDir }),
    );
    expect(dupErr.message).toContain("alice");
    expect(await readFile(path, "utf8")).toBe(before);

    await expectConfigError(
      addMember({ council: "demo", memberId: " alice ", cwd: ".", role: "r", baseDir }),
    );
    expect(await readFile(path, "utf8")).toBe(before);

    // Case-sensitive: "Alice" is NOT a duplicate of "alice".
    await addMember({ council: "demo", memberId: "Alice", cwd: ".", role: "r", baseDir });
    const cfg = await loadCouncilConfig(path);
    expect(cfg.members.map((m) => m.id).sort()).toEqual(["Alice", "alice"]);

    // Pure applyAddMember duplicate path — throws and does not mutate the doc.
    const doc = parseDocument(VALID_FIXTURE);
    const jsBefore = JSON.stringify(doc.toJS());
    expect(() =>
      applyAddMember(doc, { id: "alice", cwd: ".", role: "r", tools: "read-only" }),
    ).toThrow(ConfigError);
    expect(JSON.stringify(doc.toJS())).toBe(jsBefore);
  });

  // TP-04 — invalid --tools is rejected (not silently coerced); file unchanged.
  it("rejects an invalid --tools value without coercion; file unchanged (TP-04)", async () => {
    const path = await writeFixture("demo");
    const before = await readFile(path, "utf8");
    for (const bad of ["garbage-mode", "READ-ONLY", "readwrite", ""]) {
      const err = await expectConfigError(
        addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", tools: bad, baseDir }),
      );
      expect(err.message).toContain("tools");
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  // TP-05 — empty/whitespace/non-string required fields rejected with field-naming.
  it("rejects empty/whitespace/non-string required fields naming the field (TP-05)", async () => {
    await writeFixture("demo");
    for (const memberId of ["", "   "]) {
      const err = await expectConfigError(
        addMember({ council: "demo", memberId, cwd: ".", role: "r", baseDir }),
      );
      expect(err.message).toContain("memberId");
    }
    for (const cwd of ["", "   "]) {
      const err = await expectConfigError(
        addMember({ council: "demo", memberId: "m", cwd, role: "r", baseDir }),
      );
      expect(err.message).toContain("cwd");
    }
    for (const role of ["", "   "]) {
      const err = await expectConfigError(
        addMember({ council: "demo", memberId: "m", cwd: ".", role, baseDir }),
      );
      expect(err.message).toContain("role");
    }
    // Non-string (type-guard) — cast to bypass the compile-time string type.
    const err = await expectConfigError(
      addMember({
        council: "demo",
        memberId: "m",
        cwd: 123 as unknown as string,
        role: "r",
        baseDir,
      }),
    );
    expect(err.message).toContain("cwd");
  });

  // TP-06 — memberId charset ^[A-Za-z0-9][A-Za-z0-9._-]*$ is enforced.
  it("enforces the memberId charset (TP-06)", async () => {
    const path = await writeFixture("demo");
    const before = await readFile(path, "utf8");
    for (const bad of [".", "..", ".hidden", "-lead", "_lead", "a b", "a/b", "a@b", ""]) {
      const err = await expectConfigError(
        addMember({ council: "demo", memberId: bad, cwd: ".", role: "r", baseDir }),
      );
      expect(err.message).toContain("memberId");
      expect(await readFile(path, "utf8")).toBe(before);
    }
    // Accept table (must start alphanumeric) — each added to a fresh fixture.
    for (const good of ["a", "a1", "a.b_c-1", "Alice"]) {
      await writeFixture("demo");
      await addMember({ council: "demo", memberId: good, cwd: ".", role: "r", baseDir });
      const cfg = await loadCouncilConfig(path);
      expect(cfg.members.some((m) => m.id === good)).toBe(true);
    }
  });

  // TP-07 — missing council dir / missing council.yaml → ConfigError; nothing created.
  it("throws ConfigError when the council dir or council.yaml is missing (TP-07)", async () => {
    const missingPath = resolveCouncilConfigPath("demo", baseDir);
    const err1 = await expectConfigError(
      addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", baseDir }),
    );
    expect(err1.message).toContain(missingPath);
    expect(await exists(join(baseDir, "council"))).toBe(false);

    // Directory present but no council.yaml.
    await mkdir(join(baseDir, "council", "demo2"), { recursive: true });
    const err2 = await expectConfigError(
      addMember({ council: "demo2", memberId: "m", cwd: ".", role: "r", baseDir }),
    );
    expect(err2.message).toContain(resolveCouncilConfigPath("demo2", baseDir));
    expect(await exists(resolveCouncilConfigPath("demo2", baseDir))).toBe(false);
  });

  // TP-08 — malformed (unparseable) YAML → ConfigError; file not overwritten.
  it("throws ConfigError on malformed YAML and does not overwrite (TP-08)", async () => {
    const path = await writeFixture("demo", "name: demo\nmembers: [\n  - id: oops\n");
    const before = await readFile(path, "utf8");
    await expectConfigError(
      addMember({ council: "demo", memberId: "m", cwd: ".", role: "r", baseDir }),
    );
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await tempFiles("demo")).toEqual([]);
  });

  // TP-09 — parseable-but-already-invalid council.yaml → ConfigError; not overwritten.
  it("throws ConfigError on a parseable-but-invalid council.yaml; not overwritten (TP-09)", async () => {
    // Parses fine but missing orchestrator → re-validation fails.
    const path = await writeFixture(
      "demo",
      "name: demo\ngoal: g\nmembers:\n  - id: alice\n    cwd: .\n    role: r\n",
    );
    const before = await readFile(path, "utf8");
    await expectConfigError(
      addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir }),
    );
    expect(await readFile(path, "utf8")).toBe(before);

    // Sub-case: `members` not a sequence → structural ConfigError; not overwritten.
    const path2 = await writeFixture(
      "demo3",
      "name: demo\ngoal: g\nmembers: not-a-list\norchestrator:\n  cwd: .\n",
    );
    const before2 = await readFile(path2, "utf8");
    await expectConfigError(
      addMember({ council: "demo3", memberId: "bob", cwd: ".", role: "r", baseDir }),
    );
    expect(await readFile(path2, "utf8")).toBe(before2);
  });

  // TP-10 — round-trip preservation of comments, unknown keys, orchestrator, members.
  it("preserves comments, unknown keys, orchestrator, and pre-existing members (TP-10)", async () => {
    const path = await writeFixture("demo");
    await addMember({ council: "demo", memberId: "bob", cwd: "../bob", role: "Reviewer", baseDir });

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# Council configuration — keep this comment.");
    expect(raw).toContain("founding member — keep this inline comment");
    expect(raw).toContain("unknownKey: keepme");
    expect(raw).toContain("orchestrator:");
    expect(raw).toContain("maxRounds: 5");

    const cfg = await loadCouncilConfig(path);
    expect(cfg.members.map((m) => m.id).sort()).toEqual(["alice", "bob"]);
    expect(cfg.members.find((m) => m.id === "alice")).toMatchObject({
      cwd: "../alice",
      role: "Lead",
      tools: "read-write",
      agent: "lead-agent",
    });
  });

  // TP-11 — atomic write uses a same-dir temp + rename; no leftover temp file.
  it("writes via a same-dir temp + rename and leaves no temp file (TP-11)", async () => {
    await writeFixture("demo");
    const dir = join(baseDir, "council", "demo");
    await addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir });

    const entries = await readdir(dir);
    expect(entries).toContain("council.yaml");
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);

    // The rename moved a same-directory temp matching the unique shape.
    const renameCalls = vi.mocked(rename).mock.calls;
    expect(renameCalls.length).toBeGreaterThanOrEqual(1);
    const [tempArg, targetArg] = renameCalls[renameCalls.length - 1];
    expect(dirname(String(tempArg))).toBe(dir);
    expect(String(targetArg)).toBe(join(dir, "council.yaml"));
    expect(basename(String(tempArg))).toMatch(/^\.council\.yaml\.\d+\..+\.tmp$/);
  });

  // TP-12 — injected write/rename failure leaves the file unchanged, no temp.
  it("leaves the file unchanged and no temp on an injected write/rename failure (TP-12)", async () => {
    // Sub-case A: rename rejects after the temp is written.
    const pathA = await writeFixture("demo");
    const beforeA = await readFile(pathA, "utf8");
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename boom"));
    const errA = await expectConfigError(
      addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir }),
    );
    expect(errA.cause).toBeInstanceOf(Error);
    expect((errA.cause as Error).message).toBe("rename boom");
    expect(await readFile(pathA, "utf8")).toBe(beforeA);
    expect(await tempFiles("demo")).toEqual([]);

    // Sub-case B: the temp writeFile rejects.
    const pathB = await writeFixture("demo2");
    const beforeB = await readFile(pathB, "utf8");
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("write boom"));
    const errB = await expectConfigError(
      addMember({ council: "demo2", memberId: "bob", cwd: ".", role: "r", baseDir }),
    );
    expect(errB.cause).toBeInstanceOf(Error);
    expect((errB.cause as Error).message).toBe("write boom");
    expect(await readFile(pathB, "utf8")).toBe(beforeB);
    expect(await tempFiles("demo2")).toEqual([]);
  });

  // The original error wins even if best-effort temp cleanup also fails.
  it("re-throws the original error when temp cleanup (rm) also fails (TP-12)", async () => {
    const path = await writeFixture("demo");
    const before = await readFile(path, "utf8");
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename boom"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("rm boom"));
    const err = await expectConfigError(
      addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir }),
    );
    // The ORIGINAL rename failure propagates, not the swallowed cleanup error.
    expect((err.cause as Error).message).toBe("rename boom");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  // A non-map (scalar) member entry is skipped by the duplicate scan; the
  // edited config is then rejected by re-validation (file unchanged).
  it("skips non-map member entries while scanning for duplicates (TP-09)", async () => {
    const path = await writeFixture(
      "demo",
      "name: demo\ngoal: g\nmembers:\n  - just-a-scalar\n  - id: alice\n    cwd: .\n    role: r\norchestrator:\n  cwd: .\n",
    );
    const before = await readFile(path, "utf8");
    await expectConfigError(
      addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir }),
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });

  // TP-13 — sequential and concurrent adds leave a valid, uncorrupted file.
  it("keeps the file valid across sequential and concurrent adds (TP-13)", async () => {
    // Sequential — all three survive when serialized.
    await writeFixture("seq");
    for (const id of ["m1", "m2", "m3"]) {
      await addMember({ council: "seq", memberId: id, cwd: ".", role: "r", baseDir });
    }
    const seqCfg = await loadCouncilConfig(resolveCouncilConfigPath("seq", baseDir));
    expect(seqCfg.members.map((m) => m.id).sort()).toEqual(["alice", "m1", "m2", "m3"]);
    expect(await tempFiles("seq")).toEqual([]);

    // Concurrent — file stays valid/uncorrupted; >= 1 new member; no leftover temp.
    // (Last-writer-wins may drop some — the documented v0 single-writer limitation.)
    await writeFixture("conc");
    await Promise.all(
      ["c1", "c2", "c3"].map((id) =>
        addMember({ council: "conc", memberId: id, cwd: ".", role: "r", baseDir }),
      ),
    );
    const concCfg = await loadCouncilConfig(resolveCouncilConfigPath("conc", baseDir));
    expect(concCfg.members.length).toBeGreaterThanOrEqual(2);
    expect(["c1", "c2", "c3"].some((id) => concCfg.members.some((m) => m.id === id))).toBe(true);
    expect(await tempFiles("conc")).toEqual([]);
  });

  // TP-16 — entry + success logs emitted; console.log never called.
  it("emits entry and success logs and never calls console.log (TP-16)", async () => {
    await writeFixture("demo");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger, records } = createCapturingLogger();

    await addMember({
      council: "demo",
      memberId: "bob",
      cwd: ".",
      role: "r",
      tools: "read-write",
      baseDir,
      logger,
    });

    const entry = records.filter((r) => r.message === "council.add-member");
    expect(entry).toHaveLength(1);
    expect(entry[0].fields).toMatchObject({ council: "demo", memberId: "bob" });

    const success = records.filter((r) => r.message === "council.add-member.succeeded");
    expect(success).toHaveLength(1);
    expect(success[0].fields).toMatchObject({
      council: "demo",
      memberId: "bob",
      tools: "read-write",
    });

    expect(records.some((r) => r.message === "council.add-member.failed")).toBe(false);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // TP-17 — failure log carries the ConfigError code plus council and memberId.
  it("emits a failure log carrying code + council + memberId before re-throw (TP-17)", async () => {
    const { logger, records } = createCapturingLogger();
    await expectConfigError(
      addMember({ council: "demo", memberId: "bob", cwd: ".", role: "r", baseDir, logger }),
    );
    const failed = records.filter((r) => r.message === "council.add-member.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].fields).toMatchObject({
      council: "demo",
      memberId: "bob",
      code: "CONFIG_ERROR",
    });
  });

  // Traversal guard reaches through addMember (E8) — escaping council rejected.
  // Thread-1 fix: path resolution now happens INSIDE the try (after the entry
  // log), so even an invalid / escaping <council> still emits the entry log and
  // a council.add-member.failed record carrying the code (entry/success/failure
  // logging contract, CORE-COMPONENT-0005).
  it("rejects an escaping <council> via addMember and still logs entry + failure (TP-14)", async () => {
    const { logger, records } = createCapturingLogger();
    const err = await expectConfigError(
      addMember({ council: "../../etc", memberId: "m", cwd: ".", role: "r", baseDir, logger }),
    );
    expect(err.message).toContain("../../etc");

    expect(records.filter((r) => r.message === "council.add-member")).toHaveLength(1);
    const failed = records.filter((r) => r.message === "council.add-member.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].fields).toMatchObject({
      council: "../../etc",
      memberId: "m",
      code: "CONFIG_ERROR",
    });
  });
});

describe("applyAddMember (pure)", () => {
  it("throws a ConfigError when members is absent or not a sequence", () => {
    const doc = parseDocument("name: x\ngoal: y\norchestrator:\n  cwd: .\n");
    expect(() => applyAddMember(doc, { id: "a", cwd: ".", role: "r", tools: "read-only" })).toThrow(
      ConfigError,
    );
  });
});
