# About This Project

Codex Trace Viewer is a local observability workbench for people who use Codex
repeatedly and need to understand what happened in a session, not just whether
the final answer arrived.

## Project Goals

1. Make a day's activity easy to browse without searching raw files.
2. Make a single session understandable as a trace tree, timeline, graph, and
   conversation.
3. Make slow, failed, tool-heavy, or token-heavy work easy to find.
4. Turn local usage history into a useful daily review while keeping the data
   local.

## Design Principles

- **Local first**: no hosted collector, telemetry endpoint, or required account.
- **Trace before summary**: every metric should be traceable back to local data.
- **Explicit reduction**: raw bundles are never silently rewritten by the UI.
- **Operational clarity**: errors explain what happened and what action is
  available next.
- **Progressive detail**: date and session lists stay scannable; node payloads
  load on demand.
- **Guided setup**: the native Electron app detects Codex CLI, lets people pick
  a trace directory, and stores the local configuration before opening the
  viewer.

## Relationship to Codex and Langfuse

The viewer consumes Codex rollout trace bundles and uses the local Codex CLI for
raw bundle reduction. It borrows interaction ideas familiar from Langfuse, but
it does not embed Langfuse, send data to Langfuse, or depend on Langfuse source
code.

## Scope

This repository contains the standalone viewer, native Electron shell, first-run
setup wizard, daily review logic, Windows installer, fixtures, and tests. It
intentionally does not include a Codex source checkout or local trace data.

## License and Ownership

The code is available under the MIT License. Copyright 2026 Jin Zhangzheng.
Contributions and issue reports are welcome through the project's GitHub
repository:

<https://github.com/Jane-o-O-o-O/Make-Codex-Your-Own>
