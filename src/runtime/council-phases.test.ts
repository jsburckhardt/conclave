import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextPrompt,
  draftPrompt,
  epicsPrompt,
  normalizePolicy,
  openQuestionsPrompt,
  refinementPrompt,
  resolveArtifactPath,
  resolveRoles,
  runBacklogCouncil,
  validationPrompt,
} from "./council-phases.js";
import { CouncilRuntime, type MemberSession, type SessionFactory } from "./council-runtime.js";
import { TranscriptStore } from "../store/transcript-store.js";
import { ArtifactStore } from "../store/artifact-store.js";
import { ConfigError, CouncilError, OrchestrationError, SessionError } from "../errors.js";
import type { CouncilConfig } from "../config/council-config.js";
import type { LogFields, Logger } from "../logging/logger.js";

// --- Shared fixtures (CORE-COMPONENT-0009: co-located, node env, temp dirs) ---

function councilConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    name: "demo",
    goal: "Produce a backlog for Project X",
    members: [
      { id: "proj", cwd: ".", role: "Source of truth for the target project", tools: "read-only" },
      { id: "scrum", cwd: ".", role: "Scrum SME and backlog author", tools: "read-only" },
    ],
    orchestrator: { cwd: ".", policy: {} },
    artifacts: ["artifacts/backlog.md", "artifacts/epics.md"],
    ...overrides,
  };
}

type Script = (memberId: string, prompt: string, index: number) => string;

/** Recording/scripting/throwing/blank-capable fake SessionFactory. */
function recordingFactory(script: Script): {
  factory: SessionFactory;
  calls: { memberId: string; prompt: string }[];
  stop: ReturnType<typeof vi.fn>;
} {
  const calls: { memberId: string; prompt: string }[] = [];
  const stop = vi.fn(async () => {});
  const factory: SessionFactory = {
    start: async () => {},
    createSession: async (member): Promise<MemberSession> => ({
      sendAndWait: async (prompt: string) => {
        const index = calls.length;
        calls.push({ memberId: member.id, prompt });
        return script(member.id, prompt, index);
      },
    }),
    stop,
  };
  return { factory, calls, stop };
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
  const logger: Logger = {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
  return { logger, records };
}

const tempDirs: string[] = [];

async function makeStores(): Promise<{
  dir: string;
  transcriptPath: string;
  transcript: TranscriptStore;
  artifacts: ArtifactStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), "council-phases-"));
  tempDirs.push(dir);
  const transcriptPath = join(dir, "transcript", "full.md");
  return {
    dir,
    transcriptPath,
    transcript: new TranscriptStore(transcriptPath),
    artifacts: new ArtifactStore(dir),
  };
}

async function harness(config: CouncilConfig, script: Script) {
  const stores = await makeStores();
  const { factory, calls, stop } = recordingFactory(script);
  const { logger, records } = recordingLogger();
  const runtime = new CouncilRuntime({
    config,
    sessionFactory: factory,
    transcript: stores.transcript,
    artifacts: stores.artifacts,
    logger,
  });
  return { ...stores, calls, stop, logger, records, runtime };
}

function countBlocks(transcript: string): number {
  return (transcript.match(/^## /gm) ?? []).length;
}

const DEFAULT_RESPONSES = [
  "summary",
  "draft",
  "validation",
  "refined",
  "# Epics\n- E1",
  "# Open Questions\n- Q1",
];
const defaultScript: Script = (_id, _prompt, i) => DEFAULT_RESPONSES[i] ?? "ok";

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

// --- TASK-02: normalizePolicy -------------------------------------------------

describe("normalizePolicy", () => {
  it("TP-02: applies the documented defaults", () => {
    const expected = { writeArtifacts: true, requireProjectValidation: true, maxRounds: 1 };
    expect(normalizePolicy(undefined)).toEqual(expected);
    expect(normalizePolicy({})).toEqual(expected);
  });

  it("TP-03: rejects non-integer/negative maxRounds with ConfigError", () => {
    for (const value of [-1, -0.5, 1.5, NaN]) {
      let err: unknown;
      try {
        normalizePolicy({ maxRounds: value });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_ERROR");
      expect((err as Error).message).toContain(String(value));
    }
  });

  it("TP-04: rejects the contradictory policy with OrchestrationError", () => {
    let err: unknown;
    try {
      normalizePolicy({ requireProjectValidation: true, maxRounds: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as OrchestrationError).code).toBe("ORCHESTRATION_ERROR");
    expect((err as Error).message.length).toBeGreaterThan(0);
  });

  it("TP-05: coerces booleans and accepts non-contradictory maxRounds:0", () => {
    expect(
      normalizePolicy({ writeArtifacts: "yes" as never, requireProjectValidation: 0 as never }),
    ).toEqual({ writeArtifacts: true, requireProjectValidation: true, maxRounds: 1 });
    expect(
      normalizePolicy({ writeArtifacts: false, requireProjectValidation: false, maxRounds: 0 }),
    ).toEqual({ writeArtifacts: false, requireProjectValidation: false, maxRounds: 0 });
  });
});

// --- TASK-03: resolveRoles ----------------------------------------------------

describe("resolveRoles", () => {
  it("TP-06: resolves distinct context + backlog ids from config", () => {
    const { contextMemberId, backlogMemberId } = resolveRoles(councilConfig());
    expect(contextMemberId).toBe("proj");
    expect(backlogMemberId).toBe("scrum");
  });

  it("TP-07: fails closed on a missing role (single-member scaffold)", () => {
    const config = councilConfig({
      members: [
        {
          id: "project-x",
          cwd: ".",
          role: "Source of truth for the target project",
          tools: "read-only",
        },
      ],
    });
    let err: unknown;
    try {
      resolveRoles(config);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as Error).message).toContain("backlog");
  });

  it("TP-08: fails closed on an ambiguous role (names both candidates)", () => {
    const config = councilConfig({
      members: [
        {
          id: "proj",
          cwd: ".",
          role: "Source of truth for the target project",
          tools: "read-only",
        },
        { id: "scrum1", cwd: ".", role: "Scrum master", tools: "read-only" },
        { id: "scrum2", cwd: ".", role: "Backlog owner", tools: "read-only" },
      ],
    });
    let err: unknown;
    try {
      resolveRoles(config);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as Error).message).toContain("scrum1");
    expect((err as Error).message).toContain("scrum2");
  });

  it("TP-09: fails closed when context and backlog are not distinct", () => {
    const config = councilConfig({
      members: [
        {
          id: "solo",
          cwd: ".",
          role: "Project architect and scrum backlog author",
          tools: "read-only",
        },
        { id: "other", cwd: ".", role: "documentation writer", tools: "read-only" },
      ],
    });
    let err: unknown;
    try {
      resolveRoles(config);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as Error).message).toContain("distinct");
  });
});

// --- TASK-05: resolveArtifactPath ---------------------------------------------

describe("resolveArtifactPath", () => {
  it("TP-10: basename-matches config.artifacts, else defaults under artifacts/", () => {
    const configArtifacts = ["artifacts/backlog.md", "artifacts/epics.md"];
    expect(resolveArtifactPath("backlog", configArtifacts)).toBe("artifacts/backlog.md");
    expect(resolveArtifactPath("epics", configArtifacts)).toBe("artifacts/epics.md");
    expect(resolveArtifactPath("open-questions", configArtifacts)).toBe(
      "artifacts/open-questions.md",
    );
  });
});

// --- TASK-04/05/07: runBacklogCouncil -----------------------------------------

describe("runBacklogCouncil", () => {
  it("TP-11: drives the exact (memberId, prompt) call order with body-free logging", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { runtime, calls, artifacts, logger, records } = await harness(config, defaultScript);
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });

    const [summary, draft, validation, refined] = DEFAULT_RESPONSES;
    expect(calls).toEqual([
      { memberId: "proj", prompt: contextPrompt(config.goal) },
      { memberId: "scrum", prompt: draftPrompt(summary) },
      { memberId: "proj", prompt: validationPrompt(draft) },
      { memberId: "scrum", prompt: refinementPrompt(draft, validation) },
      { memberId: "scrum", prompt: epicsPrompt(refined) },
      { memberId: "scrum", prompt: openQuestionsPrompt(refined) },
    ]);

    expect(result.phases).toEqual(["context", "draft", "validation", "refinement", "artifacts"]);
    expect(result.rounds).toBe(1);
    expect(result.contextMemberId).toBe("proj");
    expect(result.backlogMemberId).toBe("scrum");

    const messages = records.map((r) => r.message);
    expect(messages).toContain("council.roles.resolved");
    expect(messages).toContain("phase.context.start");
    expect(messages).toContain("phase.draft.start");
    expect(messages).toContain("phase.validation.start");
    expect(messages).toContain("phase.refinement.start");
    expect(messages).toContain("phase.artifacts.written");

    // CORE-COMPONENT-0005 / R7: no log field carries a prompt or response body.
    const scripted = new Set(DEFAULT_RESPONSES);
    for (const record of records) {
      for (const value of Object.values(record.fields ?? {})) {
        expect(scripted.has(value as string)).toBe(false);
      }
    }
  });

  it("TP-12: writes artifacts to expected paths with non-blank content", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { dir, runtime, artifacts, logger } = await harness(config, defaultScript);
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });

    const backlog = await readFile(join(dir, "artifacts", "backlog.md"), "utf8");
    const epics = await readFile(join(dir, "artifacts", "epics.md"), "utf8");
    const openQuestions = await readFile(join(dir, "artifacts", "open-questions.md"), "utf8");

    expect(backlog).toBe("refined");
    expect(epics.trim().length).toBeGreaterThan(0);
    expect(openQuestions.trim().length).toBeGreaterThan(0);
    expect(result.artifacts).toEqual([
      join(dir, "artifacts", "backlog.md"),
      join(dir, "artifacts", "epics.md"),
      join(dir, "artifacts", "open-questions.md"),
    ]);
    expect(result.artifactsSkipped).toBe(false);
  });

  it("TP-13: appends exactly one transcript block per exchange (no double append)", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { transcriptPath, runtime, artifacts, logger, calls } = await harness(
      config,
      defaultScript,
    );
    await runtime.start();
    await runBacklogCouncil(runtime, config, { artifacts, logger });

    const transcript = await readFile(transcriptPath, "utf8");
    expect(countBlocks(transcript)).toBe(6);
    expect(calls.length).toBe(6);
    const headerIds = [...transcript.matchAll(/^## (\S+) /gm)].map((m) => m[1]);
    expect(headerIds).toEqual(["proj", "scrum", "proj", "scrum", "scrum", "scrum"]);
  });

  it("TP-14: re-running overwrites artifacts in place and appends the transcript", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { dir, transcriptPath, transcript, artifacts } = await makeStores();

    const run = async (refined: string): Promise<void> => {
      const { factory } = recordingFactory(
        (_id, _prompt, i) =>
          ["summary", "draft", "validation", refined, "# Epics", "# Open Questions"][i] ?? "ok",
      );
      const { logger } = recordingLogger();
      const runtime = new CouncilRuntime({
        config,
        sessionFactory: factory,
        transcript,
        artifacts,
        logger,
      });
      await runtime.start();
      await runBacklogCouncil(runtime, config, { artifacts, logger });
      await runtime.stop();
    };

    await run("refined-v1");
    const n1 = countBlocks(await readFile(transcriptPath, "utf8"));
    expect(await readFile(join(dir, "artifacts", "backlog.md"), "utf8")).toBe("refined-v1");

    await run("refined-v2");
    const n2 = countBlocks(await readFile(transcriptPath, "utf8"));
    expect(await readFile(join(dir, "artifacts", "backlog.md"), "utf8")).toBe("refined-v2");
    expect(n2).toBe(2 * n1);
  });

  it("TP-15: writeArtifacts:false runs all phases + transcript but writes no files", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { writeArtifacts: false, requireProjectValidation: true, maxRounds: 1 },
      },
    });
    const { dir, transcriptPath, runtime, artifacts, logger, calls } = await harness(
      config,
      defaultScript,
    );
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });

    expect(result.artifacts).toEqual([]);
    expect(result.artifactsSkipped).toBe(true);
    expect(calls.length).toBe(4);
    expect(existsSync(join(dir, "artifacts"))).toBe(false);
    expect(countBlocks(await readFile(transcriptPath, "utf8"))).toBe(4);
  });

  it("TP-16: requireProjectValidation:false skips validation and refines from the draft", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { requireProjectValidation: false, writeArtifacts: true, maxRounds: 1 },
      },
    });
    const script: Script = (_id, _prompt, i) =>
      ["summary", "draft", "refined", "# Epics", "# Open Questions"][i] ?? "ok";
    const { runtime, artifacts, logger, calls, records } = await harness(config, script);
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });

    expect(calls.map((c) => c.memberId)).toEqual(["proj", "scrum", "scrum", "scrum", "scrum"]);
    expect(result.validationSkipped).toBe(true);
    expect(records.map((r) => r.message)).toContain("phase.validation.skipped");

    const refinementCall = calls[2];
    expect(refinementCall.prompt).toBe(refinementPrompt("draft"));
    expect(refinementCall.prompt).not.toContain("Project validation feedback");
    expect(calls.some((c) => c.prompt === validationPrompt("draft"))).toBe(false);
  });

  it("TP-17: rounds are bounded by maxRounds", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { requireProjectValidation: true, writeArtifacts: false, maxRounds: 2 },
      },
    });
    const { transcriptPath, runtime, artifacts, logger, calls } = await harness(
      config,
      (_id, _prompt, i) => `r${i}`,
    );
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });

    expect(calls.map((c) => c.memberId)).toEqual([
      "proj",
      "scrum",
      "proj",
      "scrum",
      "proj",
      "scrum",
    ]);
    expect(result.rounds).toBe(2);
    expect(countBlocks(await readFile(transcriptPath, "utf8"))).toBe(6);
  });

  it("runs zero rounds when maxRounds is 0 and validation is disabled", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { requireProjectValidation: false, writeArtifacts: false, maxRounds: 0 },
      },
    });
    const { runtime, artifacts, logger, calls } = await harness(
      config,
      (_id, _prompt, i) => `r${i}`,
    );
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });

    expect(calls.map((c) => c.memberId)).toEqual(["proj", "scrum"]);
    expect(result.rounds).toBe(0);
    expect(result.phases).toEqual(["context", "draft"]);
    expect(result.validationSkipped).toBe(true);
    expect(result.artifactsSkipped).toBe(true);
  });

  it("defaults the logger when options.logger is omitted", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { requireProjectValidation: false, writeArtifacts: false, maxRounds: 1 },
      },
    });
    const stores = await makeStores();
    const { factory, calls } = recordingFactory((_id, _prompt, i) => `r${i}`);
    const runtime = new CouncilRuntime({
      config,
      sessionFactory: factory,
      transcript: stores.transcript,
      artifacts: stores.artifacts,
    });
    await runtime.start();

    const result = await runBacklogCouncil(runtime, config, { artifacts: stores.artifacts });

    expect(result.rounds).toBe(1);
    expect(calls.length).toBe(3);
  });

  it("TP-18: a contradictory policy throws before any ask", async () => {
    const config = councilConfig({
      orchestrator: { cwd: ".", policy: { requireProjectValidation: true, maxRounds: 0 } },
    });
    const { dir, runtime, artifacts, logger, calls } = await harness(config, defaultScript);
    await runtime.start();
    await expect(runBacklogCouncil(runtime, config, { artifacts, logger })).rejects.toBeInstanceOf(
      OrchestrationError,
    );
    expect(calls.length).toBe(0);
    expect(existsSync(join(dir, "artifacts"))).toBe(false);
  });

  it("TP-19: a bad maxRounds throws ConfigError before any ask", async () => {
    for (const maxRounds of [-1, 1.5]) {
      const config = councilConfig({ orchestrator: { cwd: ".", policy: { maxRounds } } });
      const { runtime, artifacts, logger, calls } = await harness(config, defaultScript);
      await runtime.start();
      await expect(
        runBacklogCouncil(runtime, config, { artifacts, logger }),
      ).rejects.toBeInstanceOf(ConfigError);
      expect(calls.length).toBe(0);
    }
  });

  it.each<[string, number]>([
    ["context", 0],
    ["draft", 1],
    ["validation", 2],
    ["refinement", 3],
    ["epics", 4],
    ["open-questions", 5],
  ])(
    "TP-20: a blank response in the %s phase raises OrchestrationError",
    async (phase, blankIndex) => {
      const config = councilConfig({
        orchestrator: {
          cwd: ".",
          policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
        },
      });
      const blank = blankIndex % 2 === 0 ? "" : "   ";
      const script: Script = (_id, _prompt, i) =>
        i === blankIndex ? blank : (DEFAULT_RESPONSES[i] ?? "ok");
      const { dir, runtime, artifacts, logger } = await harness(config, script);
      await runtime.start();

      await expect(
        runBacklogCouncil(runtime, config, { artifacts, logger }),
      ).rejects.toBeInstanceOf(OrchestrationError);

      if (blankIndex < 4) {
        // Failure happens before any artifact is written.
        expect(existsSync(join(dir, "artifacts"))).toBe(false);
      } else if (phase === "epics") {
        expect(existsSync(join(dir, "artifacts", "epics.md"))).toBe(false);
        expect(existsSync(join(dir, "artifacts", "open-questions.md"))).toBe(false);
      } else {
        expect(existsSync(join(dir, "artifacts", "open-questions.md"))).toBe(false);
      }
    },
  );

  it("TP-21: a mid-phase throw propagates, preserves the transcript, and stop() still runs", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const script: Script = (_id, _prompt, i) => {
      if (i === 2) {
        throw new SessionError("session blew up");
      }
      return DEFAULT_RESPONSES[i] ?? "ok";
    };
    const { transcriptPath, runtime, artifacts, logger, stop } = await harness(config, script);
    await runtime.start();

    let caught: unknown;
    try {
      await runBacklogCouncil(runtime, config, { artifacts, logger });
    } catch (e) {
      caught = e;
    } finally {
      try {
        await runtime.stop();
      } catch {
        /* logged separately by the caller */
      }
    }

    expect(caught).toBeInstanceOf(SessionError);
    expect(caught).toBeInstanceOf(CouncilError);
    expect(countBlocks(await readFile(transcriptPath, "utf8"))).toBe(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("TP-22: an unknown member id raises SessionError (no silent skip)", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { runtime, artifacts, logger } = await harness(config, defaultScript);
    await runtime.start();

    // (a) Seam check: the runtime never silently skips an unknown member.
    await expect(runtime.askMember("ghost", "x")).rejects.toBeInstanceOf(SessionError);

    // (b) Orchestrator check: a SessionError from askMember propagates untouched.
    vi.spyOn(runtime, "askMember").mockRejectedValue(new SessionError("forced"));
    await expect(runBacklogCouncil(runtime, config, { artifacts, logger })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("TP-23: an artifact write failure raises OrchestrationError(cause); transcript intact", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { transcriptPath, runtime, artifacts, logger, records } = await harness(
      config,
      defaultScript,
    );
    await runtime.start();
    const cause = new Error("disk full");
    vi.spyOn(artifacts, "write").mockRejectedValueOnce(cause);

    let caught: unknown;
    try {
      await runBacklogCouncil(runtime, config, { artifacts, logger });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).cause).toBe(cause);
    expect(records.some((r) => r.level === "error" && r.message === "phase.artifacts.error")).toBe(
      true,
    );
    // The four reasoning-phase transcript blocks survive the failed write.
    expect(countBlocks(await readFile(transcriptPath, "utf8"))).toBe(4);
  });

  it("TP-23b: a traversal artifact path surfaces as OrchestrationError wrapping the store Error", async () => {
    const config = councilConfig({
      artifacts: ["../escape/backlog.md", "artifacts/epics.md"],
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const { runtime, artifacts, logger } = await harness(config, defaultScript);
    await runtime.start();

    let caught: unknown;
    try {
      await runBacklogCouncil(runtime, config, { artifacts, logger });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OrchestrationError);
    const inner = (caught as OrchestrationError).cause;
    expect(inner).toBeInstanceOf(Error);
    expect((inner as Error).message).toMatch(/Path traversal denied/);
  });

  it("TP-24: imports no @github/copilot-sdk and never hardcodes member ids", () => {
    const source = readFileSync(new URL("./council-phases.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@github/copilot-sdk");
    expect(source).not.toContain("project-x");
    expect(source).not.toContain("scrum-sme");
  });

  it("TP-26: a stop() failure does not mask the original error", async () => {
    const config = councilConfig({
      orchestrator: {
        cwd: ".",
        policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true },
      },
    });
    const script: Script = (_id, _prompt, i) => {
      if (i === 0) {
        throw new OrchestrationError("primary");
      }
      return "ok";
    };
    const stores = await makeStores();
    const { factory, stop } = recordingFactory(script);
    stop.mockRejectedValue(new Error("stop failed"));
    const { logger } = recordingLogger();
    const runtime = new CouncilRuntime({
      config,
      sessionFactory: factory,
      transcript: stores.transcript,
      artifacts: stores.artifacts,
      logger,
    });
    await runtime.start();

    let caught: unknown;
    try {
      await runBacklogCouncil(runtime, config, { artifacts: stores.artifacts, logger });
    } catch (e) {
      caught = e;
    } finally {
      try {
        await runtime.stop();
      } catch {
        /* a stop() failure is logged separately and must not mask the primary error */
      }
    }

    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as Error).message).toBe("primary");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
