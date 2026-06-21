import { Command } from "commander";
import { scaffoldCouncil } from "./commands/init.js";
import { addMember } from "./config/add-member.js";
import { loadCouncilConfig } from "./config/council-config.js";
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

/** Human-facing not-yet-implemented notice (CORE-COMPONENT-0005 exception). */
function notImplemented(command: string): void {
  process.stderr.write(`'council ${command}' is not implemented yet (see project backlog)\n`);
  process.exitCode = 1;
}

/**
 * Build the `council` commander program with all four subcommands wired. The
 * `add-member` action is a thin adapter that delegates entirely to
 * {@link addMember} (no edit/IO logic lives here); `init`/`run`/`continue`
 * preserve their existing behavior. Lives in a covered module so CLI behavior
 * is unit-testable in-process via {@link main} (research R6).
 */
export function buildProgram(deps: CliDeps = {}): Command {
  const logger = deps.logger ?? createLogger();
  const baseDir = deps.baseDir;
  const program = new Command();

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
    .option("-c, --config <path>", "path to council.yaml", "council.yaml")
    .action(async (council: string, options: { config: string }) => {
      const config = await loadCouncilConfig(options.config);
      logger.info("council.run", { council, members: config.members.length, goal: config.goal });
      notImplemented("run");
    });

  program
    .command("continue")
    .description("Resume a previously persisted council")
    .argument("<council>", "council name")
    .action((council: string) => {
      logger.info("council.continue", { council });
      notImplemented("continue");
    });

  return program;
}

/**
 * Parse `argv` and run the matched command. Any error thrown by an async action
 * is logged as `council.error` (including the `code` for typed
 * {@link CouncilError}s) and the process exit code is set to `1` — never
 * `process.exit`, so in-process tests survive (CORE-COMPONENT-0008).
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<void> {
  const logger = deps.logger ?? createLogger();
  try {
    await buildProgram({ ...deps, logger }).parseAsync(argv);
  } catch (error: unknown) {
    logger.error("council.error", {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof CouncilError ? { code: error.code } : {}),
    });
    process.exitCode = 1;
  }
}
