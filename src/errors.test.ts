import { describe, it, expect } from "vitest";
import {
  CouncilError,
  ConfigError,
  SessionError,
  OrchestrationError,
  StateError,
} from "./errors.js";
import {
  OrchestrationError as RootOrchestrationError,
  StateError as RootStateError,
} from "./index.js";

describe("errors", () => {
  it("CouncilError carries a code and is an Error", () => {
    const err = new CouncilError("boom", "X_CODE");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("X_CODE");
    expect(err.name).toBe("CouncilError");
  });

  it("ConfigError uses the CONFIG_ERROR code", () => {
    expect(new ConfigError("bad config").code).toBe("CONFIG_ERROR");
  });

  it("SessionError preserves the underlying cause", () => {
    const cause = new Error("inner");
    const err = new SessionError("outer", { cause });
    expect(err.code).toBe("SESSION_ERROR");
    expect(err.cause).toBe(cause);
  });

  // TP-01: OrchestrationError shape and export.
  it("OrchestrationError carries the ORCHESTRATION_ERROR code, name, cause, and hierarchy", () => {
    const cause = new Error("boom");
    const err = new OrchestrationError("x", { cause });
    expect(err.code).toBe("ORCHESTRATION_ERROR");
    expect(err.name).toBe("OrchestrationError");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(CouncilError);
    expect(err).toBeInstanceOf(Error);
  });

  it("OrchestrationError constructs without a cause", () => {
    const err = new OrchestrationError("x");
    expect(err.code).toBe("ORCHESTRATION_ERROR");
    expect(err.cause).toBeUndefined();
  });

  it("OrchestrationError resolves from the package root with the same class identity", () => {
    expect(RootOrchestrationError).toBe(OrchestrationError);
    expect(new RootOrchestrationError("x")).toBeInstanceOf(CouncilError);
  });

  // TP-01: StateError shape and export.
  it("TP-01: StateError carries the STATE_ERROR code, name, cause, and hierarchy", () => {
    const cause = new Error("io");
    const err = new StateError("boom", { cause });
    expect(err.code).toBe("STATE_ERROR");
    expect(err.name).toBe("StateError");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(CouncilError);
    expect(err).toBeInstanceOf(Error);
  });

  it("TP-01: StateError constructs without a cause", () => {
    const err = new StateError("boom");
    expect(err.code).toBe("STATE_ERROR");
    expect(err.cause).toBeUndefined();
  });

  it("TP-01: StateError resolves from the package root with the same class identity", () => {
    expect(RootStateError).toBe(StateError);
    expect(new RootStateError("x")).toBeInstanceOf(CouncilError);
  });
});
