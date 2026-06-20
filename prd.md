# Conclave

Copilot SDK and the Council Idea

The Copilot SDK probably helps a lot.

It means the council does not need to automate terminal panes or fragile interactive Copilot CLI sessions. Instead, you can build a real orchestrator app that programmatically creates and controls Copilot-powered sessions.

The key shift is this:

Before SDK:

  Council orchestrator
    -> spawn terminal session
    -> type into Copilot CLI
    -> scrape stdout
    -> repeat

With SDK:

  Council orchestrator
    -> create Copilot SDK session for project-x
    -> create Copilot SDK session for scrum-sme
    -> send structured prompts
    -> receive structured events
    -> persist sessions
    -> write council artifacts

That is a much better foundation.

The SDK gives you programmatic access to the Copilot agent runtime: sessions, prompts, streaming, tools, file access, permissions, and persistence.

So your idea becomes:

  "A council runtime that creates multiple Copilot sessions, gives each one a repo-local identity, and lets an orchestrator route structured messages between them."

Architecture

  council-runtime
    ├── Orchestrator Session
    ├── Project X Session
    ├── Scrum SME Session
    ├── Transcript Store
    ├── Artifact Writer
    └── Permission Policy

Each council member can be represented by a Copilot SDK session.

Example:

  const projectSession = await client.createSession({
    sessionId: "council-scrum-project-x/project-x",
    workingDirectory: "/repos/project-x",
    agent: "project-architect",
    streaming: true,
  });

  const scrumSession = await client.createSession({
    sessionId: "council-scrum-project-x/scrum-sme",
    workingDirectory: "/repos/scrum-sme",
    agent: "scrum-master",
    streaming: true,
  });

The exact SDK config shape may need adjustment while implementing, but the important idea is solid:

  - one session per council member
  - one working directory per repo
  - one persistent session ID per member
  - one orchestrator that controls the conversation

The Biggest Design Unlock: Members as Tools

The most interesting pattern is this:

  The orchestrator itself can be a Copilot SDK session,
  and the other council members can be exposed as tools.

So the orchestrator gets tools like:

  ask_project_x(prompt)
  ask_scrum_sme(prompt)
  write_artifact(path, content)
  read_transcript()
  record_decision(title, rationale)

Then you tell the orchestrator:

  Goal:
  Create the initial backlog for Project X.

  Available council members:
  - project-x: source of truth for product and technical context
  - scrum-sme: source of truth for Scrum, backlog, and story quality

  Use the council-member tools to ask them questions.
  Do not invent project requirements.
  Resolve disagreement explicitly.
  Write final artifacts to /artifacts.

Then the orchestrator can call:

  ask_project_x(
    "Summarize the product, users, architecture, and known constraints."
  )

Then:

  ask_scrum_sme(
    "Given this project summary, propose epics and backlog items."
  )

Then:

  ask_project_x(
    "Validate this backlog against the actual repo. What is wrong or missing?"
  )

This gives you the feeling of Copilot sessions talking to each other, but the orchestration is clean, observable, and controllable.

Why SDK Is Better Than CLI Automation

  Need                         Raw Copilot CLI          Copilot SDK
  ----------------------------------------------------------------------
  Start sessions               Possible but awkward     Native API
  Send prompts                 CLI / shell              sendAndWait / streaming
  Keep member memory           Harder                   Session IDs and resume
  Observe what agents do       Scrape output            Structured events
  Track subagents              Hard                     Built-in events
  Control tools/permissions    CLI config               Permission handlers
  Build UI                     Awkward                  Event stream is ideal
  Add council tools            Harder                   SDK tools / MCP

Custom Agents

The SDK also supports custom agents.

This gives you two possible models.

Model A: Multi-session council

  project-x session
  scrum-sme session
  security-sme session
  orchestrator session

Best when each council member maps to a separate repo and working directory.

Model B: Single-session with subagents

  one orchestrator session
    ├── project-context subagent
    ├── scrum-master subagent
    └── critic subagent

Best when all agents can share one workspace/context.

For your specific cross-repo idea, I would start with Model A.

Each repo gets its own SDK session with its own:

  - working directory
  - AGENTS.md
  - tools
  - permissions
  - session ID
  - local repo context

Later, inside each repo session, you can still use custom agents/subagents.

MCP as the Council Bus

MCP could become the “council bus”.

You could build a small council MCP server exposing tools like:

  list_council_members()
  ask_member(member_id, prompt)
  read_council_file(path)
  write_council_file(path, content)
  append_transcript(turn)
  record_decision(decision)

Then Copilot can invoke council operations as tools instead of you hardcoding every step.

Possible architecture:

  Copilot SDK Orchestrator Session
    |
    |-- MCP: council tools
    |      |-- ask project-x session
    |      |-- ask scrum-sme session
    |      |-- write artifacts
    |      |-- append transcript
    |
    |-- Project X SDK Session
    |-- Scrum SME SDK Session

This is probably the grown-up architecture.

Session Persistence

Session persistence is very relevant.

Each council member should have a stable session ID:

  sessionId: council/scrum-project-x/orchestrator
  sessionId: council/scrum-project-x/project-x
  sessionId: council/scrum-project-x/scrum-sme

So later you can do:

  council continue scrum-project-x

And each member can continue from previous context.

The council repo still stores durable artifacts:

  council/scrum-project-x/
    transcript/
    artifacts/
    decisions.md
    open-questions.md
    council.yaml

So you have both:

  - Copilot session memory
  - file-based council memory

Do not rely only on session memory. Keep the file artifacts as the source of truth.

MVP

I would not start with terminal multiplexing.

I would build:

  council init
  council add-member
  council run
  council continue

Backed by SDK sessions.

Example council config:

  name: scrum-project-x
  goal: Create the initial backlog for Project X

  members:
    project-x:
      cwd: ../../project-x
      role: Source of truth for Project X
      agent: project-architect
      tools: read-only

    scrum-sme:
      cwd: ../../scrum-sme
      role: Scrum and backlog expert
      agent: scrum-master
      tools: read-only

  orchestrator:
    cwd: .
    model: gpt-5
    policy:
      max_rounds: 5
      require_project_validation: true
      write_artifacts: true

  artifacts:
    - artifacts/backlog.md
    - artifacts/epics.md
    - artifacts/open-questions.md
    - artifacts/decisions.md

Run:

  council run scrum-project-x

Internally:

  1. Create or resume orchestrator session.
  2. Create or resume project-x session.
  3. Create or resume scrum-sme session.
  4. Ask project-x for project context.
  5. Ask scrum-sme to draft backlog.
  6. Ask project-x to validate.
  7. Ask scrum-sme to refine.
  8. Ask orchestrator to synthesize.
  9. Write artifacts.
  10. Save transcript and events.

Pseudo Code

  import { CopilotClient } from "@github/copilot-sdk";

  type CouncilMember = {
    id: string;
    cwd: string;
    role: string;
    agent?: string;
  };

  class CouncilRuntime {
    private client: CopilotClient;
    private sessions = new Map<string, any>();

    constructor(private councilId: string, private members: CouncilMember[]) {
      this.client = new CopilotClient();
    }

    async start() {
      await this.client.start();

      for (const member of this.members) {
        const session = await this.client.createSession({
          sessionId: `${this.councilId}/${member.id}`,
          workingDirectory: member.cwd,
          agent: member.agent,
          streaming: true,
          onPermissionRequest: async (request) => {
            // For v0, keep members read-only unless explicitly allowed.
            return { kind: "approve-once" };
          },
        });

        this.sessions.set(member.id, session);
      }
    }

    async askMember(memberId: string, prompt: string): Promise<string> {
      const session = this.sessions.get(memberId);

      if (!session) {
        throw new Error(`Unknown council member: ${memberId}`);
      }

      const response = await session.sendAndWait({
        prompt: `
  You are council member: ${memberId}

  Respond in a structured way.
  Separate facts, assumptions, risks, and recommendations.

  Task:
  ${prompt}
        `.trim(),
      });

      const content = response?.data?.content ?? "";

      await this.appendTranscript(memberId, prompt, content);

      return content;
    }

    async runBacklogCouncil() {
      const projectSummary = await this.askMember(
        "project-x",
        "Summarize the product, users, architecture, constraints, known gaps, and likely backlog areas. Use the repository as source of truth."
      );

      const backlogDraft = await this.askMember(
        "scrum-sme",
        `
  Using this project summary, create an initial backlog.

  Project summary:
  ${projectSummary}

  Produce:
  - epics
  - user stories
  - acceptance criteria
  - risks
  - open questions
        `.trim()
      );

      const validation = await this.askMember(
        "project-x",
        `
  Validate this backlog against the actual Project X repository.

  Backlog draft:
  ${backlogDraft}

  Identify:
  - incorrect assumptions
  - missing technical constraints
  - missing product context
  - stories that do not match the project
        `.trim()
      );

      const refinedBacklog = await this.askMember(
        "scrum-sme",
        `
  Refine the backlog using the project validation feedback.

  Original backlog:
  ${backlogDraft}

  Project validation:
  ${validation}

  Produce the final backlog in Markdown.
        `.trim()
      );

      await this.writeArtifact("artifacts/backlog.md", refinedBacklog);
    }

    async appendTranscript(memberId: string, prompt: string, response: string) {
      // Append to council/scrum-project-x/transcript/full.md
      // Keep this boring and file-based for v0.
    }

    async writeArtifact(path: string, content: string) {
      // Write final council artifact.
    }

    async stop() {
      await this.client.stop();
    }
  }

Mental Model

  Copilot CLI = terminal-native agent experience

  Copilot SDK = programmable Copilot agent runtime

  Council = orchestration layer that coordinates multiple SDK sessions

The council should not be “a bunch of terminal windows talking”.

It should be:

  A repo-native, SDK-backed, multi-session orchestration runtime
  where each member is a Copilot session grounded in its own repo,
  and the orchestrator routes messages, records decisions,
  and produces durable artifacts.

Recommended v0

  - TypeScript
  - Copilot SDK
  - one session per member
  - persistent session IDs
  - council.yaml
  - transcript markdown
  - artifact folder
  - simple fixed council phases
  - no terminal automation
  - no MCP yet

Recommended v1

  - custom ask_member tool
  - orchestrator session
  - streaming UI
  - permission policies
  - member-specific tools
  - resumable councils

Recommended v2

  - MCP council server
  - dynamic council phases
  - subagent visualization
  - voting / disagreement tracking
  - issue creation / PR generation
  - reusable council recipes

The best one-line framing:

  "Council is a programmable orchestration layer for composing multiple Copilot-powered repo agents into a structured, auditable discussion that produces artifacts."

```
