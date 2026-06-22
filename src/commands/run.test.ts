import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runCouncil } from "./run.js";
import { CouncilStateStore, type CouncilState } from "../store/council-state-store.js";
import { type MemberSession, type SessionFactory } from "../runtime/council-runtime.js";
import { ConfigError, CouncilError } from "../errors.js";
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

type Script = (memberId: string, prompt: string, index: number) => string;

const DEFAULT_RESPONSES = [
  "summary",
  "draft",
  "validation",
  "refined",
  "# Epics\n- E1",
  "# Q\n- Q1",
];
const defaultScript: Script = (_id, _prompt, i) => DEFAULT_RESPONSES[i] ?? "ok";

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

const tempDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-run-"));
  tempDirs.push(dir);
  return dir;
}

/** Write `council/demo/council.yaml` (+ optional `state.json`) under `baseDir`. */
async function seedCouncil(
  baseDir: string,
  opts: { yaml?: string; state?: unknown } = {},
): Promise<string> {
  const dir = join(baseDir, "council", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "council.yaml"), opts.yaml ?? stringify(councilConfig()), "utf8");
  if (opts.state !== undefined) {
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

describe("runCouncil producer (TP-24)", () => {
  it("writes initial in-progress → per-phase checkpoints → terminal completed", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { yaml: stringify(councilConfig()) });
    const lockPath = join(councilDir, ".council.lock");
    const statePath = join(councilDir, "state.json");

    const { logger, records } = recordingLogger();
    // Observe the lock during the run: capture its presence on the first ask.
    let lockSeenDuringRun = false;
    const rec = recordingFactory((id, prompt, i) => {
      if (!lockSeenDuringRun) {
        lockSeenDuringRun = existsSync(lockPath);
      }
      return defaultScript(id, prompt, i);
    });

    // Spy on the store write to capture the full state sequence (status/timestamps),
    // calling through so state.json is still written atomically to disk.
    const writeSpy = vi.spyOn(CouncilStateStore.prototype, "write");

    await runCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    const states = writeSpy.mock.calls.map((c) => c[0] as CouncilState);

    // 1 initial + 5 phase checkpoints + 1 terminal = 7 writes.
    expect(states).toHaveLength(7);

    // Initial write: in-progress, lastPhase null, before any session is created.
    expect(states[0]).toMatchObject({
      schemaVersion: 1,
      councilId: "demo",
      status: "in-progress",
      lastPhase: null,
      lastRound: 0,
      members: [
        { id: "proj", sessionId: "demo/proj" },
        { id: "scrum", sessionId: "demo/scrum" },
      ],
    });
    expect(states[0].products).toBeUndefined();
    expect(states[0].configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(writeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      rec.createSession.mock.invocationCallOrder[0],
    );

    // Per-phase checkpoints, in order.
    expect(states.slice(1, 6).map((s) => s.lastPhase)).toEqual([
      "context",
      "draft",
      "validation",
      "refinement",
      "artifacts",
    ]);
    expect(states[1].products).toEqual({ summary: "summary" });
    expect(states[2].products).toEqual({ backlog: "draft" });
    expect(states.every((s) => s.status === "in-progress" || s === states[6])).toBe(true);

    // Terminal write: completed.
    expect(states[6]).toMatchObject({ status: "completed", lastPhase: "artifacts", lastRound: 1 });

    // updatedAt is monotonic non-decreasing across the sequence (ISO strings).
    for (let i = 1; i < states.length; i++) {
      expect(states[i].updatedAt >= states[i - 1].updatedAt).toBe(true);
    }

    // state.json on disk reflects the terminal completed state.
    const onDisk = JSON.parse(await readFile(statePath, "utf8")) as CouncilState;
    expect(onDisk.status).toBe("completed");
    expect(onDisk.lastPhase).toBe("artifacts");

    // The lock existed during the run and is removed afterwards; no orphan temp files.
    expect(lockSeenDuringRun).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    const leftover = (await readdir(councilDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);

    // state.write was logged for every persisted state (initial + checkpoints + terminal).
    const writeLogs = records.filter((r) => r.message === "state.write");
    expect(writeLogs).toHaveLength(7);
  });

  it("rejects with ConfigError before any session when config.name !== slug", async () => {
    const baseDir = await makeBaseDir();
    await seedCouncil(baseDir, { yaml: stringify(councilConfig({ name: "other" })) });
    const rec = recordingFactory();
    const { logger } = recordingLogger();

    await expect(
      runCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory }),
    ).rejects.toBeInstanceOf(ConfigError);

    // Identity is enforced before the runtime starts: no session was created.
    expect(rec.created).toHaveLength(0);
    expect(rec.start).not.toHaveBeenCalled();
    // No state.json or lock left behind by the rejected run.
    expect(existsSync(join(baseDir, "council", "demo", "state.json"))).toBe(false);
    expect(existsSync(join(baseDir, "council", "demo", ".council.lock"))).toBe(false);
  });

  it("clears a stale lock with --force (lock.forced logged) and runs to completion", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { yaml: stringify(councilConfig()) });
    const lockPath = join(councilDir, ".council.lock");
    await writeFile(lockPath, "{}\n", "utf8"); // stale lock from a crashed run.
    const rec = recordingFactory();
    const { logger, records } = recordingLogger();

    await runCouncil({
      council: "demo",
      force: true,
      baseDir,
      logger,
      sessionFactory: rec.factory,
    });

    expect(records.some((r) => r.message === "lock.forced")).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.status).toBe("completed");
  });

  it("logs council.stop.error when stop() fails without masking the completed run", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { yaml: stringify(councilConfig()) });
    const rec = recordingFactory();
    rec.stop.mockRejectedValue(new Error("teardown blew up"));
    const { logger, records } = recordingLogger();

    await runCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });

    // The run still completes; the teardown failure is logged separately.
    expect(records.find((r) => r.message === "council.stop.error")?.fields).toMatchObject({
      message: "teardown blew up",
    });
    const finalState = JSON.parse(
      await readFile(join(councilDir, "state.json"), "utf8"),
    ) as CouncilState;
    expect(finalState.status).toBe("completed");
    expect(existsSync(join(councilDir, ".council.lock"))).toBe(false);
  });

  // Thread #5: an unexpected non-CouncilError is normalized to a typed CouncilError.
  it("maps an unexpected throwable to a CouncilError and logs council.run.failed", async () => {
    const baseDir = await makeBaseDir();
    const councilDir = await seedCouncil(baseDir, { yaml: stringify(councilConfig()) });
    // A member throws a plain (non-CouncilError) Error mid-run.
    const rec = recordingFactory(() => {
      throw new Error("transcript exploded");
    });
    const { logger, records } = recordingLogger();

    const err = await runCouncil({
      council: "demo",
      baseDir,
      logger,
      sessionFactory: rec.factory,
    }).catch((e: unknown) => e);

    // Normalized to a typed CouncilError carrying a stable code.
    expect(err).toBeInstanceOf(CouncilError);
    expect((err as CouncilError).code).toBe("CONFIG_ERROR");
    expect(records.find((r) => r.message === "council.run.failed")?.fields).toMatchObject({
      council: "demo",
      code: "CONFIG_ERROR",
    });
    // The lock is still released on the failure path.
    expect(existsSync(join(councilDir, ".council.lock"))).toBe(false);
  });
});
