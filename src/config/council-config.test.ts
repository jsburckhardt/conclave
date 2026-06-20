import { describe, it, expect } from "vitest";
import { validateCouncilConfig } from "./council-config.js";
import { ConfigError } from "../errors.js";

describe("validateCouncilConfig", () => {
  it("accepts a minimal valid config and defaults members to read-only", () => {
    const config = validateCouncilConfig({
      name: "scrum-project-x",
      goal: "Create the initial backlog for Project X",
      members: [{ id: "project-x", cwd: "../project-x", role: "Source of truth" }],
      orchestrator: { cwd: "." },
    });
    expect(config.name).toBe("scrum-project-x");
    expect(config.members).toHaveLength(1);
    expect(config.members[0]?.tools).toBe("read-only");
    expect(config.artifacts).toEqual([]);
  });

  it("preserves an explicit read-write member and orchestrator policy", () => {
    const config = validateCouncilConfig({
      name: "c",
      goal: "g",
      members: [{ id: "m", cwd: ".", role: "r", tools: "read-write" }],
      orchestrator: { cwd: ".", model: "gpt-5", policy: { maxRounds: 5 } },
    });
    expect(config.members[0]?.tools).toBe("read-write");
    expect(config.orchestrator.policy?.maxRounds).toBe(5);
  });

  it("rejects a config without members", () => {
    expect(() =>
      validateCouncilConfig({ name: "x", goal: "y", members: [], orchestrator: { cwd: "." } }),
    ).toThrow(ConfigError);
  });

  it("rejects a member missing required fields", () => {
    expect(() =>
      validateCouncilConfig({
        name: "x",
        goal: "y",
        members: [{ id: "m" }],
        orchestrator: { cwd: "." },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-object input", () => {
    expect(() => validateCouncilConfig(null)).toThrow(ConfigError);
  });
});
