import { dirname, join } from "node:path";
import { resolveCouncilConfigPath } from "../config/council-config.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { TranscriptStore } from "../store/transcript-store.js";
import { ArtifactStore } from "../store/artifact-store.js";
import {
  CouncilStateStore,
  STATE_SCHEMA_VERSION,
  type CouncilState,
} from "../store/council-state-store.js";
import { CouncilLock, councilConfigHash } from "../store/council-lock.js";
import { CouncilRuntime, type SessionFactory } from "../runtime/council-runtime.js";
import { CopilotSessionFactory } from "../runtime/copilot-session-factory.js";
import {
  normalizePolicy,
  resolveRoles,
  runBacklogCouncil,
  type PhaseCheckpoint,
} from "../runtime/council-phases.js";
import {
  assertCouncilIdentity,
  loadConfigWithRaw,
  memberRegistry,
  toCouncilError,
} from "./shared.js";

/**
 * Options for {@link runCouncil}. `baseDir`, `logger`, and `sessionFactory` are
 * injectable so the producer is unit-testable in-process with a fake
 * `SessionFactory` and a temp dir (the inline `CopilotSessionFactory` is never
 * constructed in tests).
 */
export interface RunCouncilOptions {
  /** Council slug → `council/<council>/`. */
  council: string;
  /** Optional `council.yaml` path override (`-c/--config`). */
  config?: string;
  /** Clear a stale `.council.lock` before acquiring (`--force`). */
  force?: boolean;
  /** Base directory; defaults to `process.cwd()`. Injected in tests. */
  baseDir?: string;
  /** Structured logger; defaults to {@link createLogger}. Injected in tests. */
  logger?: Logger;
  /** Session factory; defaults to {@link CopilotSessionFactory}. Injected in tests. */
  sessionFactory?: SessionFactory;
}

/**
 * Run the fixed v0 backlog council and persist its resumable run state
 * (CORE-COMPONENT-0004/0006). The flow is **fail-fast then producer**:
 *
 * 1. Resolve the canonical council dir via {@link resolveCouncilConfigPath}
 *    (slug-validated, traversal-guarded); load the config + raw bytes.
 * 2. Log `council.run`, then fail-fast on contradictory policy / unresolvable
 *    roles and the `config.name === <council>` identity invariant — **before**
 *    any lock or state write, so an invalid council leaves no side effects.
 * 3. Acquire the exclusive `.council.lock`; write the initial `in-progress`
 *    `state.json` (lastPhase `null`, member registry, configHash, timestamps).
 * 4. Start the runtime and drive {@link runBacklogCouncil}, re-persisting
 *    `state.json` after each completed phase/round via the checkpoint callback.
 * 5. On success write the terminal `completed` state. A mid-run failure leaves
 *    `state.json` `in-progress` at the last checkpoint (resumable).
 * 6. `finally`: guarded `runtime.stop()` (its failure never masks the primary
 *    error) then release the lock — on every exit path.
 */
export async function runCouncil(options: RunCouncilOptions): Promise<void> {
  const { council } = options;
  const baseDir = options.baseDir ?? process.cwd();
  const logger = options.logger ?? createLogger();

  try {
    // Canonical council dir (slug-validated + traversal-guarded, E8).
    const canonicalConfigPath = resolveCouncilConfigPath(council, baseDir);
    const councilDir = dirname(canonicalConfigPath);
    const configPath = options.config ?? canonicalConfigPath;

    const { config, raw } = await loadConfigWithRaw(configPath);

    logger.info("council.run", { council, members: config.members.length, goal: config.goal });

    // Fail fast on contradictory policy / unresolvable roles / identity mismatch
    // BEFORE any side effect, so invalid config leaves no lock or state behind.
    normalizePolicy(config.orchestrator.policy);
    resolveRoles(config);
    assertCouncilIdentity(config, council);

    const transcript = new TranscriptStore(join(councilDir, "transcript", "full.md"));
    const artifacts = new ArtifactStore(councilDir);
    const stateStore = new CouncilStateStore(join(councilDir, "state.json"));
    const lock = new CouncilLock(join(councilDir, ".council.lock"));
    const sessionFactory = options.sessionFactory ?? new CopilotSessionFactory();
    const runtime = new CouncilRuntime({ config, sessionFactory, transcript, artifacts, logger });

    if (options.force) {
      logger.info("lock.forced", { council });
    }
    await lock.acquire(options.force);
    logger.info("lock.acquired", { council });

    try {
      const now = new Date().toISOString();
      let current: CouncilState = {
        schemaVersion: STATE_SCHEMA_VERSION,
        councilId: config.name,
        status: "in-progress",
        lastPhase: null,
        lastRound: 0,
        members: memberRegistry(config),
        configHash: councilConfigHash(raw),
        createdAt: now,
        updatedAt: now,
      };
      await stateStore.write(current);
      logger.info("state.write", {
        council,
        lastPhase: current.lastPhase,
        lastRound: current.lastRound,
      });

      const checkpoint = async (cp: PhaseCheckpoint): Promise<void> => {
        current = {
          ...current,
          lastPhase: cp.lastPhase,
          lastRound: cp.lastRound,
          products: cp.products,
          updatedAt: new Date().toISOString(),
        };
        await stateStore.write(current);
        logger.info("state.write", { council, lastPhase: cp.lastPhase, lastRound: cp.lastRound });
      };

      await runtime.start();
      const result = await runBacklogCouncil(runtime, config, { artifacts, logger, checkpoint });

      current = { ...current, status: "completed", updatedAt: new Date().toISOString() };
      await stateStore.write(current);
      logger.info("state.write", {
        council,
        lastPhase: current.lastPhase,
        lastRound: current.lastRound,
      });

      logger.info("council.run.complete", {
        council: config.name,
        context: result.contextMemberId,
        backlog: result.backlogMemberId,
        phases: result.phases,
        rounds: result.rounds,
        artifacts: result.artifacts.length,
        validationSkipped: result.validationSkipped,
        artifactsSkipped: result.artifactsSkipped,
      });
    } finally {
      // stop() runs on every path; its failure is logged separately and must never
      // mask the primary error (CORE-COMPONENT-0004). The lock is then released.
      try {
        await runtime.stop();
      } catch (stopErr) {
        logger.error("council.stop.error", {
          message: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
      await lock.release();
      logger.info("lock.released", { council });
    }
  } catch (error) {
    // Map any throwable (incl. non-CouncilError fs/transcript failures) to a typed
    // CouncilError so the failure log carries a stable `code`, mirroring
    // continueCouncil (CORE-COMPONENT-0008, review thread #5).
    const councilError = toCouncilError(error);
    logger.error("council.run.failed", { council, code: councilError.code });
    throw councilError;
  }
}
