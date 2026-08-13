# About Codex Trace Viewer

![Codex Trace Viewer product overview](./docs/images/product-overview.png)

> Product overview: one local desktop workspace for session discovery, trace inspection, node-level evidence, daily review, and approval-gated Harness evolution. The screenshot uses repository fixtures rather than private user data.

Codex Trace Viewer is a local-first observability and Harness evolution workspace for people who use Codex repeatedly and want to understand more than the final answer.

It reconstructs local Codex rollout traces into a navigable record of runtime turns, model generations, tool and MCP calls, child tasks, timing, token usage, failures, conversation context, and referenced payloads. It then uses that evidence to support daily review and carefully controlled improvements to the user's Codex Harness.

## The Problem

A completed Codex task hides much of the process that produced it. Terminal output, event logs, state files, tool results, and model payloads answer different parts of the story, but they are difficult to inspect together.

This makes several practical questions unnecessarily hard:

- Where did a slow or failed task spend its time?
- Which model call triggered a tool, retry, or child task?
- What tools, Skills, and MCP servers are actually useful over time?
- Which user corrections reveal a recurring Harness weakness?
- How can an improvement be applied without granting an Agent unrestricted write access?

Codex Trace Viewer turns those fragmented artifacts into a traceable evidence chain.

## What the Project Provides

### A local observability workbench

The viewer organizes activity from date to Session and from Session to individual nodes. Trace trees, waterfall timelines, relationship graphs, conversation views, and detail panels present the same execution from complementary perspectives. Raw payloads remain referenced and are loaded only when needed.

### A personal usage review

Daily reviews aggregate models, providers, projects, tools, Skills, MCP servers, token usage, active hours, failures, cancellations, and repeated calls. An optional OpenAI-compatible model can identify patterns from bounded, redacted aggregates while the rule-based report remains available as a fallback.

### An approval-gated Harness Agent

The Agent queries full or incremental Trace indexes and inspects the current Harness. During analysis it can read and create structured proposals, but it cannot execute shell commands, write arbitrary files, or call mutation tools.

Each proposal binds an evidence locator, target object, target hash, operation hash, and reviewable diff. A user can approve, edit and approve, reject, or defer each proposal independently.

### Reversible Harness evolution

![Approval-gated Harness evolution](./docs/images/harness-evolution.svg)

> Safety loop: analysis produces a proposal, human approval authorizes one exact operation, the system snapshots the target before writing, and verification failure restores the previous state.

Approved operations are executed through adapters for AGENTS instructions, Skills, MCP configuration, Rules, Hooks, Plugins, and `config.toml`. Approval tokens are scoped, expiring, and single use. Local changes are snapshotted, verified after application, and recoverable through automatic or user-confirmed rollback.

## Architecture

The project is intentionally small and local:

```text
Codex runtime
    -> local rollout trace bundles
    -> explicit Codex reduction
    -> structured state and payload references
    -> incremental trace index and query layer
    -> local Node.js service
    -> Web workspace or Electron desktop window
    -> daily review and approval-gated Harness Agent
```

No hosted collector, telemetry endpoint, database, or Langfuse deployment is required. Electron starts the same local service on an ephemeral loopback port and owns its lifecycle; the viewer can also run directly in a browser.

## Design Principles

- **Local first**: traces, reports, settings, Agent state, and snapshots remain on the user's machine by default.
- **Trace before summary**: metrics and recommendations should lead back to inspectable local evidence.
- **Explicit reduction**: active or raw bundles are not silently rewritten by the interface.
- **Progressive detail**: lists stay scannable while payloads and raw JSON load on demand.
- **Bounded analysis**: project scope, lookback, payload access, rounds, tokens, duration, and byte budgets are configurable.
- **Human write boundary**: the analysis Agent can propose, but only an explicit approval can authorize a mutation.
- **Exact authorization**: approval binds to the selected target and exact operation, not to a broad capability.
- **Recovery by default**: snapshots, verification, startup recovery, and rollback are part of the change lifecycle.
- **Operational clarity**: failures state what happened and when human verification is required.

## Trust Boundary

The local HTTP service binds to `127.0.0.1` by default. Common credential fields are redacted from Trace evidence and Harness inspection. Payload access is optional and byte-limited. API keys are stored locally and are not returned in plaintext by the settings API.

External Plugin and MCP operations may rely on Codex CLI behavior. When an external operation cannot be verified or reversed with confidence, the system records that limitation and stops for human inspection instead of claiming a successful recovery.

## Repository Scope

This repository contains:

- the Node.js viewer service and APIs;
- trace discovery, reduction, query, and indexing logic;
- daily review and optional LLM analysis;
- the Harness analysis Agent and persistent state store;
- controlled mutation, verification, snapshot, and rollback adapters;
- the Web workspace and Electron desktop shell;
- the first-run setup wizard and Windows packaging configuration;
- fixtures and automated tests for critical workflows.

It intentionally does not include a Codex source checkout or a user's local Trace data.

## Relationship to Codex and Langfuse

Codex Trace Viewer is an independent community project. It consumes local rollout trace bundles produced by compatible Codex runtimes and uses the locally installed Codex CLI for explicit trace reduction and selected external Harness operations.

The interface borrows interaction patterns familiar from observability tools such as Langfuse, but the project does not embed Langfuse, send data to Langfuse, or depend on its source code. It is not affiliated with OpenAI, Codex, or Langfuse.

## Ownership and License

Copyright 2026 Jin Zhangzheng.

The project is released under the [MIT License](./LICENSE). Contributions and issue reports are welcome at:

<https://github.com/Jane-o-O-o-O/Make-Codex-Your-Own>
