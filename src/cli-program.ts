import { Command, CommanderError } from "commander";
import { scaffoldCouncil } from "./commands/init.js";
import { addMember } from "./config/add-member.js";
import { runCouncil } from "./commands/run.js";
import { continueCouncil } from "./commands/continue.js";
import { CouncilError } from "./errors.js";
import { createLogger, type Logger } from "./logging/logger.js";

/**
 * Injectable dependencies for the in-process CLI program. Both are optional so
 * production uses real defaults (`createLogger()` + `process.cwd()`), while
 * tests inject a capturing logger and a temp `baseDir` to drive {@link main}
 * hermetically (CORE-COMPONENT-0005/0009).
 */
export interface CliDeps {
  /** Structured logger; defaults to {@link createLogger}. */
  logger?: Logger;
  /** Base directory commands resolve council paths against; defaults to cwd. */
  baseDir?: string;
}

/**
 * Build the `council` commander program with all four subcommands wired. The
 * `add-member`/`run`/`continue` actions are thin adapters that delegate entirely
 * to their command modules (no IO/orchestration logic lives here); `init`
 * preserves its existing behavior. Lives in a covered module so CLI behavior is
 * unit-testable in-process via {@link main} (research R6).
 */
export function buildProgram(deps: CliDeps = {}): Command {
  const logger = deps.logger ?? createLogger();
  const baseDir = deps.baseDir;
  const program = new Command();

  // Throw a CommanderError instead of calling process.exit() on parse failures,
  // missing required options, and --help/--version. This keeps in-process tests
  // (and any embedding of main()) alive so the catch in main() can map the
  // outcome to process.exitCode (CORE-COMPONENT-0008). Set on the root; in
  // Commander v15 it propagates to subcommands.
  program.exitOverride();

  program
    .name("council")
    .description("Conclave — a programmable orchestration layer for Copilot-powered repo councils")
    .version("0.0.0");

  program
    .command("init")
    .description("Scaffold a new council directory with a council.yaml")
    .argument("<name>", "council name")
    .action(async (name: string) => {
      logger.info("council.init", { name });
      await scaffoldCouncil({ name, baseDir, logger });
    });

  program
    .command("add-member")
    .description("Add a member to an existing council")
    .argument("<council>", "council name")
    .argument("<memberId>", "member id")
    .requiredOption("--cwd <path>", "member working directory (required)")
    .requiredOption("--role <role>", "member role (required)")
    .option("--agent <agent>", "agent name (optional)")
    .option("--tools <mode>", "member capability: read-only | read-write", "read-only")
    .action(
      async (
        council: string,
        memberId: string,
        options: { cwd: string; role: string; agent?: string; tools: string },
      ) => {
        await addMember({
          council,
          memberId,
          cwd: options.cwd,
          role: options.role,
          agent: options.agent,
          tools: options.tools,
          baseDir,
          logger,
        });
      },
    );

  program
    .command("run")
    .description("Run the council phases to produce artifacts")
    .argument("<council>", "council name")
    .option("-c, --config <path>", "path to council.yaml")
    .option("--force", "clear a stale .council.lock before running")
    .action(async (council: string, options: { config?: string; force?: boolean }) => {
      await runCouncil({ council, config: options.config, force: options.force, baseDir, logger });
    });

  program
    .command("continue")
    .description("Resume a previously persisted council")
    .argument("<council>", "council name")
    .option("-c, --config <path>", "path to council.yaml")
    .option("--force", "clear a stale .council.lock and override member-set drift")
    .action(async (council: string, options: { config?: string; force?: boolean }) => {
      await continueCouncil({
        council,
        config: options.config,
        force: options.force,
        baseDir,
        logger,
      });
    });

  return program;
}

/**
 * Parse `argv` and run the matched command. Errors thrown by an async action are
 * logged as `council.error` (including the `code` for typed {@link CouncilError}s)
 * and the exit code is set to `1`. With {@link Command.exitOverride} enabled,
 * Commander surfaces parse failures, missing-option errors, and the normal
 * `--help`/`--version` display as a {@link CommanderError} carrying an
 * `exitCode`: that code is honored verbatim, and a `0` exit (help/version) is a
 * success — neither logged as an error nor forced to `1`. The process exit code
 * is only ever set, never `process.exit`, so in-process tests survive
 * (CORE-COMPONENT-0008).
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<void> {
  const logger = deps.logger ?? createLogger();
  try {
    await buildProgram({ ...deps, logger }).parseAsync(argv);
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      // exitCode 0 is the normal --help/--version display, not a failure.
      if (error.exitCode !== 0) {
        logger.error("council.error", { error: error.message, code: error.code });
      }
      process.exitCode = error.exitCode;
      return;
    }
    logger.error("council.error", {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof CouncilError ? { code: error.code } : {}),
    });
    process.exitCode = 1;
  }
}
