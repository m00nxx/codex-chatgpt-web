# Changelog

All notable changes to ChatGPT Web Continuum are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). ChatGPT Web remains the real model
backend: this fork does not replace it with API credits or reduce it to a secondary tool.

## [Unreleased]

### Added

- Added an immutable, turn-bound MCP context spool for full tool-capable turns that exceed a
  measured single-message ChatGPT transport boundary but still fit the underlying model context.
  One small browser bootstrap reads ordered chunks through `codex_context_next`; it does not send
  additional browser messages or open retry chats.
- Added a SHA-256 root digest, per-chunk hash chain, strict cursor ordering, idempotent last-chunk
  replay, and an explicit final root acknowledgement before task execution can begin.
- Added an account-scoped browser send gate with configurable minimum spacing and a persisted
  cooldown after a real ChatGPT `429` response.
- Added launcher visibility for the transport actually selected after browser proof: `FULL`,
  `DELTA`, or `STATELESS`, with a controlled reset reason in local activity.
- Added fail-closed quarantine and recovery tests for malformed Continuum and rate-limit state.

### Changed

- Preserve the complete compiled Continuum metadata across the launcher browser-helper process,
  including the task key, delta plan, previous marker, compaction count, and full reset fallback.
- Added the read-only `codex_context_next` action to the `Codex Native2` public MCP contract. An
  existing 2.2.0 connector must refresh its action catalog before testing this unreleased source.
- Expire completed task-bound browser surfaces after two idle hours while leaving running turns
  untouched; the next task turn safely performs a full synchronization.
- Preserve queued reasoning and commentary until the adapter drains them, eliminating a completion
  race that could otherwise omit trace events from a very fast browser turn.
- Reject implausible future timestamps in persisted limiter state instead of allowing a corrupt
  file to pin sends indefinitely.

### Safety

- Context spooling is never selected to exceed the model context window, never applies to an
  unverified delta fallback, and never truncates the compiled prompt. Excessive spool size or
  overhead leaves the existing explicit context error unchanged.
- A skipped cursor, digest mismatch, early normal tool, early final answer, cancellation, or broker
  loss permanently fails that browser attempt closed; no Continuum acknowledgement is committed.
- A request observed during a rate-limit cooldown fails locally and is never queued to become an
  automatic browser send later.
- Rate-limit and Continuum recovery files contain no prompt, answer, cookie, profile, tunnel, or
  capability-token data.

## [2.2.0] - 2026-08-21

### Added

- Added the Continuum stateful transport for ChatGPT Web Sol models in the desktop launcher.
- Bound each native Codex task to an opaque, task-specific Temporary Chat browser surface.
- Sent the required complete context on the first turn and only the unacknowledged ordered delta on
  later proven turns.
- Added a bounded, digest-only local ledger for system prompts, semantic message prefixes, completed
  answers, and expected browser markers. It does not persist prompt text, answer text, images,
  cookies, browser profiles, tunnel credentials, or capability tokens.
- Added exact previous-marker verification before a retained ChatGPT transcript can receive a delta.
- Added controlled full-context reset paths for new tasks, forks, compaction or prefix mismatches,
  missing prior output, launcher restarts, closed or evicted surfaces, and browser marker mismatches.
- Added `--context-mode stateful|stateless`, `--browser-turn-retries N`, and
  `--browser-retry-backoff-ms N` setup options.
- Added unit and adapter-lifecycle coverage for first turns, deltas, tool rounds, images, resume,
  fork, compaction, mismatch, restart, browser errors, rate limits, and retained launcher surfaces.

### Changed

- Changed automatic browser-turn retries from three to a safe default of zero.
- Made explicitly enabled non-rate-limit retries bounded and subject to exponential backoff.
- Made ChatGPT `429` rate-limit responses terminal for the current browser attempt so they never
  trigger another automatic message.
- Retained successfully completed Continuum task surfaces and evicted the least-recently-used idle
  surface when the five-surface safety limit is reached. Failed, aborted, and unproven surfaces are
  destroyed.
- Preserved the complete Codex harness: `Codex Native2`, the OpenAI tunnel, per-turn capabilities,
  streaming SSE, cancellation, visible reasoning, images, tool calls and results, sandboxing, and
  approval boundaries continue to operate in the same browser response.
- Updated package, launcher, updater, installer, documentation, and release URLs for the
  `m00nxx/codex-chatgpt-web` fork.
- Incorporated the canonical Lexical non-breaking-space prompt readback fix.

### Safety and recovery

- Continuum acknowledges context only after a completed ChatGPT answer is observed and committed.
- Any missing or conflicting local or browser evidence selects a complete reset; it never silently
  truncates context or claims that unproven context was consumed.
- Task surfaces remain isolated and the launcher continues to expose control endpoints only through
  authenticated loopback channels.
- No retry or model-switch path was added to bypass ChatGPT product limits.

### Validation

- Passed dependency audit, TypeScript checks, core and launcher test suites, production builds, and
  the relocatable-runtime smoke test locally.
- Passed the GitHub release matrix on Ubuntu, Windows, macOS ARM64, and macOS Intel, including
  `bun run verify`, launcher packaging, application smoke tests, checksums, and release publication.
- Published checksummed runtime archives and launcher installers in the
  [v2.2.0 release](https://github.com/m00nxx/codex-chatgpt-web/releases/tag/v2.2.0).

### Known limitations

- Persistent delta reuse currently requires the desktop launcher browser host. Managed-Chrome mode
  falls back to a complete fresh-chat synchronization when it cannot prove a retained surface.
- At most five task surfaces are retained. Eviction is safe but makes the next turn perform a full
  reset.
- A full reset that exceeds the measured ChatGPT transport ceiling fails closed and requires Codex
  compaction; no invisible truncation is performed.
- The automated release suite does not sign in to or send messages through a real ChatGPT account.
  A controlled Windows 11 full-harness smoke test remains a separate release-validation step.

[2.2.0]: https://github.com/m00nxx/codex-chatgpt-web/releases/tag/v2.2.0
