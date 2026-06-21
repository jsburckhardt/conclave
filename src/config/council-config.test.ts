import { describe, it, expect } from "vitest";
import { dirname, relative, resolve } from "node:path";
import { resolveCouncilConfigPath, validateCouncilConfig } from "./council-config.js";
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

describe("resolveCouncilConfigPath", () => {
  // A base dir that need NOT exist on disk — exercising the resolver against a
  // non-existent path proves it performs no filesystem IO.
  const baseDir = resolve("/tmp", "conclave-resolve-test-does-not-exist");

  // TP-15 — returns council/<council>/council.yaml under the injected baseDir.
  it("returns council/<council>/council.yaml under the injected baseDir (TP-15)", () => {
    const p = resolveCouncilConfigPath("demo", baseDir);
    expect(p).toBe(resolve(baseDir, "council", "demo", "council.yaml"));
  });

  // TP-15 — defaults baseDir to process.cwd(); callable with no council/ dir (no IO).
  it("anchors at process.cwd() when baseDir is omitted and performs no IO (TP-15)", () => {
    const p = resolveCouncilConfigPath("demo");
    expect(p).toBe(resolve(process.cwd(), "council", "demo", "council.yaml"));
    // The non-existent baseDir above never triggered a filesystem error.
    expect(() => resolveCouncilConfigPath("demo", baseDir)).not.toThrow();
  });

  // TP-14 — every accepted name resolves strictly inside the council/ root,
  // including allowlisted dot-prefixed names that the bare startsWith("..")
  // guard would wrongly reject.
  it("keeps every accepted council name strictly inside council/ (TP-14)", () => {
    const councilBase = resolve(baseDir, "council");
    for (const name of ["demo", "a.b_c-1", "..a", "..."]) {
      const dir = dirname(resolveCouncilConfigPath(name, baseDir));
      expect(relative(councilBase, dir)).toBe(name);
    }
  });

  // TP-14 — escaping <council> values are rejected via resolve+relative, not
  // string-matching alone; the ConfigError names the offending value.
  it("rejects every <council> that escapes the council root (TP-14)", () => {
    for (const name of ["..", "../../etc", "a/../..", "../sibling"]) {
      let thrown: unknown;
      try {
        resolveCouncilConfigPath(name, baseDir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).code).toBe("CONFIG_ERROR");
      expect((thrown as ConfigError).message).toContain(name);
    }
  });
});
