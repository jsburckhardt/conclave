import { basename } from "node:path";
import type { CouncilRuntime } from "./council-runtime.js";
import type { CouncilConfig, MemberConfig, OrchestratorPolicy } from "../config/council-config.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import type { CouncilPhase, CouncilStateProducts } from "../store/council-state-store.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { ConfigError, OrchestrationError } from "../errors.js";

/**
 * Fixed v0 backlog-council phase orchestrator (CORE-COMPONENT-0004).
 *
 * `runBacklogCouncil` drives an already-started {@link CouncilRuntime} through a
 * deterministic phase order — context summary → backlog draft → optional project
 * validation → refinement → optional artifact generation — using only the runtime,
 * the {@link ArtifactStore}, config types, the typed error hierarchy, and the
 * logger. It never imports the Copilot SDK package, so it is fully runnable with
 * a fake `SessionFactory`.
 *
 * Logical roles are resolved from member `role` text by a documented, fail-closed
 * heuristic (see {@link resolveRoles}); member ids are never hardcoded.
 */

/** Normalized, fully-defaulted orchestrator policy. */
export interface NormalizedPolicy {
  writeArtifacts: boolean;
  requireProjectValidation: boolean;
  maxRounds: number;
}

export interface RunBacklogCouncilOptions {
  /** CORE-COMPONENT-0006 store the orchestrator writes artifacts through. */
  artifacts: ArtifactStore;
  /** CORE-COMPONENT-0005 logger; defaults to {@link createLogger}. */
  logger?: Logger;
  /**
   * Resume start point seeded from a persisted `CouncilState` (CORE-COMPONENT-0004).
   * When present, completed phases are skipped and intermediate `products` are
   * seeded so the flow continues from `lastPhase`/`lastRound`. When absent the run
   * starts fresh (byte-identical to the pre-resume behavior).
   */
  resume?: ResumePoint;
  /**
   * Persist progress after each completed phase/round. The orchestrator owns only
   * phases/rounds/products; the caller merges the checkpoint into the full state
   * (identity, status, timestamps) and writes it through `CouncilStateStore`.
   */
  checkpoint?: (checkpoint: PhaseCheckpoint) => Promise<void>;
}

/** Where a resumed run continues from (derived from the persisted state). */
export interface ResumePoint {
  /** The last phase that completed (`null` ⇒ context never finished ⇒ start fresh). */
  lastPhase: CouncilPhase | null;
  /** Number of fully-completed refinement rounds. */
  lastRound: number;
  /** Durable intermediate products carried into the resumed flow. */
  products: CouncilStateProducts;
}

/** A progress checkpoint emitted after each completed phase/round. */
export interface PhaseCheckpoint {
  lastPhase: CouncilPhase;
  lastRound: number;
  products: CouncilStateProducts;
}

/** Result of a completed backlog-council run (no prompt/response bodies). */
export interface BacklogCouncilResult {
  /** Resolved context-source member id. */
  contextMemberId: string;
  /** Resolved backlog-author member id. */
  backlogMemberId: string;
  /** Ordered, de-duplicated phase names that executed. */
  phases: string[];
  /** Validation/refinement rounds actually run (== normalized `maxRounds`). */
  rounds: number;
  /** Absolute artifact paths written (empty when `writeArtifacts: false`). */
  artifacts: string[];
  /** True when `requireProjectValidation === false`. */
  validationSkipped: boolean;
  /** True when `writeArtifacts === false`. */
  artifactsSkipped: boolean;
}

/**
 * Documented, fail-closed role-resolution heuristic (Option B, v0).
 *
 * Each member's `role` string is matched case-insensitively:
 * - **context source** ← matches {@link CONTEXT_ROLE_PATTERN};
 * - **backlog author** ← matches {@link BACKLOG_ROLE_PATTERN}.
 */
const CONTEXT_ROLE_PATTERN =
  /\b(context|project|product|architect|repo|codebase|source of truth)\b/i;
const BACKLOG_ROLE_PATTERN = /\b(scrum|backlog|stor(y|ies)|sprint|agile|product owner)\b/i;

/**
 * Validate and normalize orchestrator policy (pure; no IO, no logging).
 *
 * Applies the documented defaults, defensively coerces the booleans (the loader
 * passes `policy` through untyped), throws {@link ConfigError} when `maxRounds`
 * is not a non-negative integer, and throws {@link OrchestrationError} for the
 * `requireProjectValidation === true && maxRounds === 0` contradiction.
 */
export function normalizePolicy(policy?: OrchestratorPolicy): NormalizedPolicy {
  const writeArtifacts = typeof policy?.writeArtifacts === "boolean" ? policy.writeArtifacts : true;
  const requireProjectValidation =
    typeof policy?.requireProjectValidation === "boolean" ? policy.requireProjectValidation : true;

  let maxRounds = 1;
  if (policy?.maxRounds !== undefined) {
    const n = policy.maxRounds;
    if (!Number.isInteger(n) || n < 0) {
      throw new ConfigError(
        `Orchestrator policy 'maxRounds' must be a non-negative integer, received: ${String(n)}`,
      );
    }
    maxRounds = n;
  }

  if (requireProjectValidation && maxRounds === 0) {
    throw new OrchestrationError(
      "Contradictory orchestrator policy: requireProjectValidation is true but maxRounds is 0. " +
        "Set maxRounds to at least 1, or disable requireProjectValidation.",
    );
  }

  return { writeArtifacts, requireProjectValidation, maxRounds };
}

function resolveSingleRole(
  role: "context" | "backlog",
  matches: MemberConfig[],
  description: string,
  remedy: string,
): string {
  if (matches.length === 0) {
    throw new OrchestrationError(
      `Cannot resolve the '${role}' role: no member's role text matches the ${description} ` +
        `heuristic. ${remedy}`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(", ");
    throw new OrchestrationError(
      `Ambiguous '${role}' role: members [${ids}] all match the ${description} heuristic. ` +
        `Make exactly one member's role match the ${role} role.`,
    );
  }
  return matches[0].id;
}

/**
 * Resolve the logical context-source and backlog-author member ids from config
 * using the fail-closed heuristic (pure). Member ids come only from
 * `config.members` (never hardcoded). Raises {@link OrchestrationError} when a
 * role is unresolved, ambiguous, or when both roles resolve to the same member.
 */
export function resolveRoles(config: CouncilConfig): {
  contextMemberId: string;
  backlogMemberId: string;
} {
  const contextMatches = config.members.filter((m) => CONTEXT_ROLE_PATTERN.test(m.role));
  const backlogMatches = config.members.filter((m) => BACKLOG_ROLE_PATTERN.test(m.role));

  const contextMemberId = resolveSingleRole(
    "context",
    contextMatches,
    "context-source",
    "Add a member whose role describes the project/context source of truth.",
  );
  const backlogMemberId = resolveSingleRole(
    "backlog",
    backlogMatches,
    "backlog-author",
    "Add a member whose role describes the scrum/backlog author.",
  );

  if (contextMemberId === backlogMemberId) {
    throw new OrchestrationError(
      `Cannot resolve distinct council roles: member '${contextMemberId}' matches both the ` +
        "context-source and backlog-author roles. A backlog council needs two distinct members; " +
        "add a separate backlog-author member (a single-member council cannot run).",
    );
  }

  return { contextMemberId, backlogMemberId };
}

/**
 * Map a logical artifact name to a relative path (pure, Q7): the first
 * `config.artifacts` entry whose basename is `<logical>.md`, else the default
 * `artifacts/<logical>.md`.
 */
export function resolveArtifactPath(logical: string, configArtifacts: string[]): string {
  const target = `${logical}.md`;
  const match = configArtifacts.find((entry) => basename(entry) === target);
  return match ?? `artifacts/${target}`;
}

// --- Pure phase prompt builders (Q5; adapted from prd.md:359–414, no preamble) ---

export function contextPrompt(goal: string): string {
  return [
    "Summarize the product, users, architecture, constraints, known gaps, and likely backlog areas.",
    "Use the repository as the source of truth.",
    "",
    "Council goal:",
    goal,
  ].join("\n");
}

export function draftPrompt(summary: string): string {
  return [
    "Using this project summary, create an initial backlog.",
    "",
    "Project summary:",
    summary,
    "",
    "Produce:",
    "- epics",
    "- user stories",
    "- acceptance criteria",
    "- risks",
    "- open questions",
  ].join("\n");
}

export function validationPrompt(backlog: string): string {
  return [
    "Validate this backlog against the actual project repository.",
    "",
    "Backlog draft:",
    backlog,
    "",
    "Identify:",
    "- incorrect assumptions",
    "- missing technical constraints",
    "- missing product context",
    "- stories that do not match the project",
  ].join("\n");
}

export function refinementPrompt(backlog: string, validation?: string): string {
  const lines = [
    "Refine the backlog into its final form in Markdown.",
    "",
    "Current backlog:",
    backlog,
  ];
  if (validation !== undefined) {
    lines.push("", "Project validation feedback:", validation);
  }
  lines.push("", "Produce the final, refined backlog in Markdown.");
  return lines.join("\n");
}

export function epicsPrompt(backlog: string): string {
  return [
    "Extract the epics from this backlog as a standalone Markdown document.",
    "",
    "Backlog:",
    backlog,
    "",
    "List each epic with a short description. Output Markdown only.",
  ].join("\n");
}

export function openQuestionsPrompt(backlog: string): string {
  return [
    "List the open questions implied by this backlog as a standalone Markdown document.",
    "",
    "Backlog:",
    backlog,
    "",
    "List each open question as a bullet. Output Markdown only.",
  ].join("\n");
}

/**
 * Ask a member and enforce the non-blank rule (CORE-COMPONENT-0004): the runtime
 * appends the exchange to the transcript inside `askMember`, so the orchestrator
 * never appends directly. A blank/whitespace-only response raises
 * {@link OrchestrationError}.
 */
async function askNonBlank(
  runtime: CouncilRuntime,
  memberId: string,
  prompt: string,
  phase: string,
): Promise<string> {
  const response = await runtime.askMember(memberId, prompt);
  if (response.trim().length === 0) {
    throw new OrchestrationError(
      `Member '${memberId}' returned a blank response in the '${phase}' phase; ` +
        "expected non-empty content.",
    );
  }
  return response;
}

/**
 * Write one artifact through the {@link ArtifactStore}, wrapping the store's
 * plain `Error` (e.g. path traversal) in {@link OrchestrationError} with the
 * cause preserved (research R2). Logs the failure without the artifact body.
 */
async function writeArtifact(
  store: ArtifactStore,
  logical: string,
  content: string,
  configArtifacts: string[],
  logger: Logger,
): Promise<string> {
  const relativePath = resolveArtifactPath(logical, configArtifacts);
  try {
    return await store.write(relativePath, content);
  } catch (cause) {
    logger.error("phase.artifacts.error", { artifact: relativePath });
    throw new OrchestrationError(`Failed to write artifact '${relativePath}'`, { cause });
  }
}

/**
 * Require a durable resume product to be present. A resumed run that skips a phase
 * but lacks the product that phase produced is an inconsistent state; surface it as
 * an actionable {@link OrchestrationError} rather than feeding `undefined` downstream.
 */
function requireSeed(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new OrchestrationError(
      `Cannot resume council: the persisted state is missing the '${name}' product ` +
        "required to continue from this phase.",
    );
  }
  return value;
}

/**
 * Run the fixed v0 backlog council. `runtime` must already be started; the caller
 * owns `runtime.stop()` (in a guarded `finally`, CORE-COMPONENT-0004).
 *
 * Resume (CORE-COMPONENT-0004): when `options.resume` is provided the orchestrator
 * skips already-completed phases, seeds intermediate products from the persisted
 * checkpoint, and continues from `lastPhase`/`lastRound`. When `options.checkpoint`
 * is provided it fires after each completed phase/round with the minimal `products`
 * needed to resume from that boundary. With neither option the behavior is identical
 * to a fresh, non-checkpointed run.
 */
export async function runBacklogCouncil(
  runtime: CouncilRuntime,
  config: CouncilConfig,
  options: RunBacklogCouncilOptions,
): Promise<BacklogCouncilResult> {
  const logger = options.logger ?? createLogger();

  // Phase 0: validate policy before any side effect.
  const policy = normalizePolicy(config.orchestrator.policy);

  // Resolve logical roles (fail-closed) before any ask.
  const { contextMemberId, backlogMemberId } = resolveRoles(config);
  logger.info("council.roles.resolved", { context: contextMemberId, backlog: backlogMemberId });

  const phases: string[] = [];
  const recordPhase = (name: string): void => {
    if (!phases.includes(name)) {
      phases.push(name);
    }
  };

  // Resume start point (absent ⇒ fresh run from the context phase).
  const resume = options.resume;
  const resumeLastPhase = resume?.lastPhase ?? null;
  const completedRounds = resume?.lastRound ?? 0;
  const seeded = resume?.products ?? {};
  const contextDone = resumeLastPhase !== null;
  const draftDone =
    resumeLastPhase === "draft" ||
    resumeLastPhase === "validation" ||
    resumeLastPhase === "refinement" ||
    resumeLastPhase === "artifacts";
  const artifactsDone = resumeLastPhase === "artifacts";

  const emitCheckpoint = async (
    lastPhase: CouncilPhase,
    lastRound: number,
    products: CouncilStateProducts,
  ): Promise<void> => {
    if (options.checkpoint) {
      await options.checkpoint({ lastPhase, lastRound, products });
    }
  };

  // Record phases already completed in a prior run so `phases` reflects the
  // council's full journey, not just this (possibly resumed) invocation.
  if (resume) {
    if (contextDone) {
      recordPhase("context");
    }
    if (draftDone) {
      recordPhase("draft");
    }
    if (
      policy.requireProjectValidation &&
      (completedRounds > 0 || resumeLastPhase === "validation")
    ) {
      recordPhase("validation");
    }
    if (completedRounds > 0) {
      recordPhase("refinement");
    }
  }

  // Phase: context summary.
  let summary = seeded.summary;
  if (!contextDone) {
    logger.info("phase.context.start", { member: contextMemberId });
    summary = await askNonBlank(runtime, contextMemberId, contextPrompt(config.goal), "context");
    recordPhase("context");
    await emitCheckpoint("context", completedRounds, { summary });
  }

  // Phase: backlog draft.
  let working = seeded.backlog;
  if (!draftDone) {
    logger.info("phase.draft.start", { member: backlogMemberId });
    working = await askNonBlank(
      runtime,
      backlogMemberId,
      draftPrompt(requireSeed(summary, "summary")),
      "draft",
    );
    recordPhase("draft");
    await emitCheckpoint("draft", completedRounds, { backlog: working });
  }

  // From here the backlog must exist (freshly drafted or seeded from state).
  let backlog = requireSeed(working, "backlog");

  // Phase: optional validation + refinement rounds.
  const validationSkipped = !policy.requireProjectValidation;
  let rounds = completedRounds;
  for (let round = completedRounds; round < policy.maxRounds; round++) {
    let validation: string | undefined;
    // The round we resume into may have its validation already done.
    const validationAlreadyDone = round === completedRounds && resumeLastPhase === "validation";
    if (policy.requireProjectValidation && !validationAlreadyDone) {
      logger.info("phase.validation.start", { member: contextMemberId, round: round + 1 });
      validation = await askNonBlank(
        runtime,
        contextMemberId,
        validationPrompt(backlog),
        "validation",
      );
      recordPhase("validation");
      await emitCheckpoint("validation", round, { backlog, validation });
    } else if (validationAlreadyDone) {
      // Resuming into the round whose validation already completed: the feedback
      // MUST be present in the persisted products, otherwise refinement would run
      // without it and diverge from the original run. Fail closed (review thread #1).
      validation = requireSeed(seeded.validation, "validation");
    } else {
      logger.info("phase.validation.skipped", { round: round + 1 });
    }

    logger.info("phase.refinement.start", { member: backlogMemberId, round: round + 1 });
    backlog = await askNonBlank(
      runtime,
      backlogMemberId,
      refinementPrompt(backlog, validation),
      "refinement",
    );
    recordPhase("refinement");
    rounds = round + 1;
    await emitCheckpoint("refinement", rounds, { backlog });
  }

  const finalBacklog = backlog;

  // Phase: optional artifact generation (gated by writeArtifacts).
  const artifacts: string[] = [];
  let artifactsSkipped = false;
  if (artifactsDone) {
    // Artifacts were written in a prior run (resume past the artifacts phase);
    // re-running is unnecessary. Record the phase so the journey stays complete.
    recordPhase("artifacts");
  } else if (policy.writeArtifacts) {
    logger.info("phase.artifacts.start", { member: backlogMemberId });

    artifacts.push(
      await writeArtifact(options.artifacts, "backlog", finalBacklog, config.artifacts, logger),
    );

    const epics = await askNonBlank(runtime, backlogMemberId, epicsPrompt(finalBacklog), "epics");
    artifacts.push(
      await writeArtifact(options.artifacts, "epics", epics, config.artifacts, logger),
    );

    const openQuestions = await askNonBlank(
      runtime,
      backlogMemberId,
      openQuestionsPrompt(finalBacklog),
      "open-questions",
    );
    artifacts.push(
      await writeArtifact(
        options.artifacts,
        "open-questions",
        openQuestions,
        config.artifacts,
        logger,
      ),
    );

    recordPhase("artifacts");
    await emitCheckpoint("artifacts", rounds, { backlog: finalBacklog });
    logger.info("phase.artifacts.written", { count: artifacts.length });
  } else {
    artifactsSkipped = true;
    logger.info("phase.artifacts.skipped", {});
  }

  return {
    contextMemberId,
    backlogMemberId,
    phases,
    rounds,
    artifacts,
    validationSkipped,
    artifactsSkipped,
  };
}
