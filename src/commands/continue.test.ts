import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { continueCouncil } from "./continue.js";
import { CouncilStateStore, type CouncilState } from "../store/council-state-store.js";
import { councilConfigHash } from "../store/council-lock.js";
import { contextPrompt, validationPrompt } from "../runtime/council-phases.js";
import { ConfigError, SessionError, StateError } from "../errors.js";
import { type MemberSession, type SessionFactory } from "../runtime/council-runtime.js";
import type { CouncilConfig } from "../config/council-config.js";
import type { LogFields, Logger } from "../logging/logger.js";

// --- Shared fixtures (mirrors 03-test-plan.md; co-located, node env, temp dirs) ---

function councilConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    name: "demo",
    goal: "Produce a backlog for Project X",
    members: [
      { id: "proj", cwd: ".", role: "Source of truth for the target project", tools: "read-only" },
      { id: "scrum", cwd: ".", role: "Scrum SME and backlog author", tools: "read-only" },
    ],
    orchestrator: {
      cwd: ".",
      policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
    },
    artifacts: ["artifacts/backlog.md", "artifacts/epics.md"],
    ...overrides,
  };
}

/** The hash of the default council.yaml bytes, so `validState` shows no drift. */
const VALID_CONFIG_HASH = councilConfigHash(stringify(councilConfig()));

type Script = (memberId: string, prompt: string, index: number) => string;
const defaultScript: Script = () => "ok";

/** Recording/scripting fake SessionFactory (records `created` + every ask). */
function recordingFactory(script: Script = defaultScript): {
  factory: SessionFactory;
  created: { councilId: string; memberId: string }[];
  calls: { memberId: string; prompt: string }[];
  start: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const created: { councilId: string; memberId: string }[] = [];
  const calls: { memberId: string; prompt: string }[] = [];
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const createSession = vi.fn(
    async (member: { id: string }, councilId: string): Promise<MemberSession> => {
      created.push({ councilId, memberId: member.id });
      return {
        sendAndWait: async (prompt: string) => {
          const index = calls.length;
          calls.push({ memberId: member.id, prompt });
          return script(member.id, prompt, index);
        },
      };
    },
  );
  const factory = { start, createSession, stop } as unknown as SessionFactory;
  return { factory, created, calls, start, createSession, stop };
}

function recordingLogger(): {
  logger: Logger;
  records: { level: string; message: string; fields?: LogFields }[];
} {
  const records: { level: string; message: string; fields?: LogFields }[] = [];
  const make =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };
  return {
    logger: { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") },
    records,
  };
}

/** A baseline in-progress `CouncilState` (resumable from the draft checkpoint). */
function validState(overrides: Partial<CouncilState> = {}): CouncilState {
  return {
    schemaVersion: 1,
    councilId: "demo",
    status: "in-progress",
    lastPhase: "draft",
    lastRound: 0,
    members: [
      { id: "proj", sessionId: "demo/proj" },
      { id: "scrum", sessionId: "demo/scrum" },
    ],
    configHash: VALID_CONFIG_HASH,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    products: { backlog: "# Backlog\n- S1" },
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-continue-"));
  tempDirs.push(dir);
  return dir;
}

/** Write `council/demo/council.yaml` (+ optional `state.json`) under `baseDir`. */
async function seedCouncil(
  baseDir: string,
  opts: { yaml?: string; state?: CouncilState; rawState?: string } = {},
): Promise<string> {
  const dir = join(baseDir, "council", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "council.yaml"), opts.yaml ?? stringify(councilConfig()), "utf8");
  if (opts.rawState !== undefined) {
    await writeFile(join(dir, "state.json"), opts.rawState, "utf8");
  } else if (opts.state !== undefined) {
    await writeFile(join(dir, "state.json"), JSON.stringify(opts.state, null, 2), "utf8");
  }
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

describe("continueCouncil resume orchestration", () => {
  it("TP-14: reuses exact stable ${councilId}/${memberId} session ids", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { state: validState() });
    const rec = recordingFactory();
    const { logger } = recordingLogger();

    await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    expect(rec.created).toEqual([
      { councilId: "demo", memberId: "proj" },
      { councilId: "demo", memberId: "scrum" },
    ]);

    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.members).toEqual([
      { id: "proj", sessionId: "demo/proj" },
      { id: "scrum", sessionId: "demo/scrum" },
    ]);
    for (const created of rec.created) {
      const stored = finalState.members.find((m) => m.id === created.memberId);
      expect(`${created.councilId}/${created.memberId}`).toBe(stored?.sessionId);
    }
  });

  it("TP-15: missing state.json → StateError, no lock, no sessions", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, {});
    const rec = recordingFactory();
    const { logger, records } = recordingLogger();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateError);
    expect((err as Error).message).toMatch(/council run demo/);

    const failed = records.find((r) => r.message === "council.continue.failed");
    expect(failed?.fields).toMatchObject({ code: "STATE_ERROR" });
    expect(existsSync(join(councilDir, ".council.lock"))).toBe(false);
    expect(rec.created).toHaveLength(0);
    expect(rec.start).not.toHaveBeenCalled();
  });

  it("TP-16: corrupt or newer schemaVersion state.json → StateError (no fresh start)", async () => {
    // (a) invalid JSON.
    const baseA = await makeBaseDir();
    await seedCouncil(baseA, { rawState: "{ broken" });
    const recA = recordingFactory();
    await expect(
      continueCouncil({
        council: "demo",
        baseDir: baseA,
        logger: recordingLogger().logger,
        sessionFactory: recA.factory,
      }),
    ).rejects.toBeInstanceOf(StateError);
    expect(recA.created).toHaveLength(0);

    // (b) newer schemaVersion.
    const baseB = await makeBaseDir();
    await seedCouncil(baseB, { state: validState({ schemaVersion: 2 }) });
    const recB = recordingFactory();
    await expect(
      continueCouncil({
        council: "demo",
        baseDir: baseB,
        logger: recordingLogger().logger,
        sessionFactory: recB.factory,
      }),
    ).rejects.toBeInstanceOf(StateError);
    expect(recB.created).toHaveLength(0);
  });

  it("TP-17: member-set drift aborts without --force, proceeds with --force", async () => {
    const baseDir = await makeBaseDir();
    const driftedConfig = councilConfig({
      members: [
        {
          id: "proj",
          cwd: ".",
          role: "Source of truth for the target project",
          tools: "read-only",
        },
        { id: "po", cwd: ".", role: "Scrum SME and backlog author", tools: "read-only" },
      ],
    });
    const councilDir = await seedCouncil(baseDir, {
      yaml: stringify(driftedConfig),
      state: validState(),
    });

    // (1) no --force → ConfigError naming the member-set change; no sessions.
    const rec1 = recordingFactory();
    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger: recordingLogger().logger,
      sessionFactory: rec1.factory,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/member set/i);
    expect(rec1.created).toHaveLength(0);

    // (2) with --force → proceeds, logs config.drift { member-set }, runs to completion.
    const rec2 = recordingFactory();
    const { logger, records } = recordingLogger();
    await continueCouncil({
      council: "demo",
      force: true,
      baseDir,
      logger,
      sessionFactory: rec2.factory,
    });
    const drift = records.find((r) => r.message === "config.drift");
    expect(drift?.fields).toMatchObject({ kind: "member-set" });
    expect(rec2.created.map((c) => c.memberId)).toEqual(["proj", "po"]);

    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.status).toBe("completed");
  });

  it("TP-18: non-structural drift warns and continues without --force", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, {
      state: validState({ configHash: "0".repeat(64) }),
    });
    const rec = recordingFactory();
    const { logger, records } = recordingLogger();

    await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    const drift = records.find((r) => r.message === "config.drift");
    expect(drift?.fields).toMatchObject({ kind: "non-structural" });
    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.status).toBe("completed");
  });

  it("TP-19: resuming a completed council is an idempotent no-op", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, {
      state: validState({ status: "completed", lastPhase: "artifacts", lastRound: 1 }),
    });
    const before = await readFile(join(councilDir, "state.json"), "utf8");
    const rec = recordingFactory();
    const { logger, records } = recordingLogger();

    await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    expect(records.some((r) => r.message === "council.continue.completed")).toBe(true);
    expect(rec.created).toHaveLength(0);
    expect(rec.start).not.toHaveBeenCalled();
    expect(existsSync(join(councilDir, ".council.lock"))).toBe(false);
    expect(await readFile(join(councilDir, "state.json"), "utf8")).toBe(before);
  });

  it("TP-20: SDK session-resume failure → SessionError, state preserved, lock released", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { state: validState() });
    const before = await readFile(join(councilDir, "state.json"), "utf8");

    const failing: SessionFactory = {
      start: vi.fn(async () => {
        throw new SessionError("Copilot SDK failed to resume the session");
      }),
      createSession: vi.fn(async () => {
        throw new SessionError("unused");
      }),
      stop: vi.fn(async () => {}),
    };
    const { logger } = recordingLogger();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger,
      sessionFactory: failing,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionError);
    expect((err as { code?: string }).code).toBe("SESSION_ERROR");
    // Persisted state is byte-for-byte unchanged → the resume is retryable.
    expect(await readFile(join(councilDir, "state.json"), "utf8")).toBe(before);
    expect(existsSync(join(councilDir, ".council.lock"))).toBe(false);
  });

  it("TP-21: concurrency guard rejects a second invocation; --force clears a stale lock", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { state: validState() });
    const lockPath = join(councilDir, ".council.lock");
    await writeFile(lockPath, "{}\n", "utf8"); // simulate an in-flight run/continue.

    // (1) no --force → StateError (lock conflict); no sessions; stale lock preserved.
    const rec1 = recordingFactory();
    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger: recordingLogger().logger,
      sessionFactory: rec1.factory,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateError);
    expect(rec1.created).toHaveLength(0);
    expect(existsSync(lockPath)).toBe(true);

    // (2) with --force → stale lock cleared (lock.forced logged), runs, lock released.
    const rec2 = recordingFactory();
    const { logger, records } = recordingLogger();
    await continueCouncil({
      council: "demo",
      force: true,
      baseDir,
      logger,
      sessionFactory: rec2.factory,
    });
    expect(records.some((r) => r.message === "lock.forced")).toBe(true);
    expect(rec2.created.map((c) => c.memberId)).toEqual(["proj", "scrum"]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("TP-22: council-identity mismatch (config.name != slug) → ConfigError", async () => {
    const baseDir = await makeBaseDir();
    // YAML name is "other" but the directory/slug is "demo".
    await seedCouncil(baseDir, { yaml: stringify(councilConfig({ name: "other" })) });
    const rec = recordingFactory();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger: recordingLogger().logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/identity mismatch/i);
    expect(rec.created).toHaveLength(0);
  });

  it("TP-23: resumes from lastPhase/lastRound and re-persists atomically", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, {
      state: validState({
        status: "in-progress",
        lastPhase: "draft",
        lastRound: 0,
        products: { backlog: "# Backlog\n- S1" },
      }),
    });
    const rec = recordingFactory();
    const { logger, records } = recordingLogger();
    const writeSpy = vi.spyOn(CouncilStateStore.prototype, "write");

    await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    // Context + draft are NOT re-asked: the first ask is the round's validation.
    expect(rec.calls[0]).toEqual({ memberId: "proj", prompt: validationPrompt("# Backlog\n- S1") });
    expect(rec.calls.map((c) => c.prompt)).not.toContain(contextPrompt(councilConfig().goal));

    // Intermediate writes advance lastPhase/lastRound, ending at a terminal completed.
    const states = writeSpy.mock.calls.map((c) => c[0] as CouncilState);
    expect(states.map((s) => s.lastPhase)).toEqual([
      "validation",
      "refinement",
      "artifacts",
      "artifacts",
    ]);
    expect(states.slice(0, 3).every((s) => s.status === "in-progress")).toBe(true);
    expect(states[states.length - 1].status).toBe("completed");
    for (let i = 1; i < states.length; i++) {
      expect(states[i].updatedAt >= states[i - 1].updatedAt).toBe(true);
    }

    // Final on-disk state is completed; artifacts written; no orphan temp file.
    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.status).toBe("completed");
    expect(existsSync(join(councilDir, "artifacts", "backlog.md"))).toBe(true);
    const leftover = (await readdir(councilDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
    expect(records.filter((r) => r.message === "state.write").length).toBe(states.length);
  });

  // --- Defensive branches / error paths (TASK-07 "all branches exercised", T9) ---

  it("aborts when the persisted councilId does not match config.name", async () => {
    const baseDir = await makeBaseDir();
    await seedCouncil(baseDir, { state: validState({ councilId: "other" }) });
    const rec = recordingFactory();
    const { logger, records } = recordingLogger();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/councilId/i);
    expect(rec.created).toHaveLength(0);
    expect(records.find((r) => r.message === "council.continue.failed")?.fields).toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("aborts when a persisted sessionId does not match the derived stable id", async () => {
    const baseDir = await makeBaseDir();
    await seedCouncil(baseDir, {
      state: validState({
        members: [
          { id: "proj", sessionId: "wrong/proj" },
          { id: "scrum", sessionId: "demo/scrum" },
        ],
      }),
    });
    const rec = recordingFactory();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger: recordingLogger().logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/session id mismatch/i);
    expect(rec.created).toHaveLength(0);
  });

  it("aborts on a differing-length member set without --force", async () => {
    const baseDir = await makeBaseDir();
    const threeMemberConfig = councilConfig({
      members: [
        {
          id: "proj",
          cwd: ".",
          role: "Source of truth for the target project",
          tools: "read-only",
        },
        { id: "scrum", cwd: ".", role: "Scrum SME and backlog author", tools: "read-only" },
        { id: "extra", cwd: ".", role: "Additional reviewer", tools: "read-only" },
      ],
    });
    await seedCouncil(baseDir, { yaml: stringify(threeMemberConfig), state: validState() });
    const rec = recordingFactory();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger: recordingLogger().logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/member set/i);
    expect(rec.created).toHaveLength(0);
  });

  it("logs council.stop.error when stop() fails during a resume without masking completion", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { state: validState() });
    const rec = recordingFactory();
    rec.stop.mockRejectedValue(new Error("teardown blew up"));
    const { logger, records } = recordingLogger();

    await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    expect(records.find((r) => r.message === "council.stop.error")?.fields).toMatchObject({
      message: "teardown blew up",
    });
    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.status).toBe("completed");
    expect(existsSync(join(councilDir, ".council.lock"))).toBe(false);
  });

  // --- Thread #4: `--config` override must stay inside the council directory ---

  it("rejects an absolute --config outside the council dir (no read, no sessions)", async () => {
    const baseDir = await makeBaseDir();
    await seedCouncil(baseDir, { state: validState() });
    const rec = recordingFactory();
    const { logger } = recordingLogger();

    const err = await continueCouncil({
      council: "demo",
      config: "/etc/passwd",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/--config/);
    expect(rec.created).toHaveLength(0);
  });

  it("rejects a relative --config that escapes the council dir", async () => {
    const baseDir = await makeBaseDir();
    await seedCouncil(baseDir, { state: validState() });
    const rec = recordingFactory();
    const { logger } = recordingLogger();

    const err = await continueCouncil({
      council: "demo",
      config: "../../secret.yaml",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/outside the council directory/i);
    expect(rec.created).toHaveLength(0);
  });

  it("accepts a relative --config inside the council dir", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { state: validState() });
    // An alternate config file that lives INSIDE the council directory.
    await writeFile(join(councilDir, "alt.yaml"), stringify(councilConfig()), "utf8");
    const rec = recordingFactory();
    const { logger } = recordingLogger();

    await continueCouncil({
      council: "demo",
      config: "alt.yaml",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    });

    // Resume proceeded using the in-dir config (sessions were created).
    expect(rec.created.map((c) => c.memberId)).toEqual(["proj", "scrum"]);
  });

  // --- Thread #6: drift detection is set-based, robust to duplicate member ids ---

  it("detects member-set drift even when config carries duplicate ids", async () => {
    const baseDir = await makeBaseDir();
    // Config has a DUPLICATE id ("proj" twice) → its real member SET is {proj},
    // which differs from the persisted SET {proj, scrum}. The pre-fix
    // length-as-set-size proxy treated these as equal and skipped drift.
    const dupConfig = councilConfig({
      members: [
        {
          id: "proj",
          cwd: ".",
          role: "Source of truth for the target project",
          tools: "read-only",
        },
        {
          id: "proj",
          cwd: ".",
          role: "Source of truth for the target project",
          tools: "read-only",
        },
      ],
    });
    await seedCouncil(baseDir, { yaml: stringify(dupConfig), state: validState() });
    const rec = recordingFactory();
    const { logger } = recordingLogger();

    const err = await continueCouncil({
      council: "demo",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    // Without --force, the genuinely-different member set must abort.
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/member set/i);
    expect(rec.created).toHaveLength(0);
  });
});
