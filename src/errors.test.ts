import { describe, it, expect } from "vitest";
import { CouncilError, ConfigError, SessionError } from "./errors.js";

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
});
