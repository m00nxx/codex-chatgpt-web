# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

## Modes

### `browser-only`

- Exposes Instant (`chatgpt-web/light`), Medium, High, and Extra High; each model advertises exactly one
  immutable Codex effort matching its ChatGPT browser mode. `chatgpt-web/pro` is appended only when
  the authenticated account exposes Pro.
- Uses Continuum task binding for Sol models: a complete first turn followed by proven deltas.
  Luna keeps its separate rolling-checkpoint transport.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same fixed models; Instant through Extra High are tool-capable, while Pro remains
  read-only.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents one outer Codex turn capability; the MCP server keeps the derived
  binding private and dispatches the requested action immediately.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

The ChatGPT connector name is also the public MCP ABI identity. The direct turn-token contract uses
`Codex Native2`; the retired `Codex Native` identity is never selected or refreshed in place. Setup
migrates known legacy local configuration to the new name, clears prior verification state, and
requires the user to create the new connector. Browser verification accepts the exact new identity,
reports a specific migration error when only the legacy identity is visible, and never falls back to
the legacy connector. Future public schema changes require another explicit connector identity.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each Codex task is leased an independent `WebContentsView`, opaque task key, and surface ID;
Playwright attaches to that exact surface through a launcher-owned loopback CDP endpoint. Model
turns never launch a second browser or copy state between task tabs. A successfully completed tab
remains bound to its task and is re-leased for the next turn. Failed, aborted, manually closed, or
unproven surfaces are destroyed. When five idle task surfaces exist, a new task evicts the least
recently used one; a sixth concurrent active turn fails explicitly. The cap avoids excessive
parallel account traffic that could trigger account abuse controls.

Sign-in uses that same persistent Electron partition. ChatGPT login pages and allowed identity-
provider popups are adopted into a temporary `WebContentsView` inside the launcher instead of being
redirected to another browser. After the provider returns to ChatGPT, the launcher requires both a
server-authenticated session and the Temporary Chat composer in the primary owned view, then closes
the temporary auth view. There is no browser-profile handoff, cookie import, CDP login port, or
temporary session-transfer directory.

Continuum keeps a bounded digest-only ledger keyed by the native Codex `thread_id`. The first turn
inserts the required compiled task context as one inline JSON envelope. After a completed browser
answer, the runtime records hashes of the semantic input prefix and final answer. A later Codex
turn may use a delta only when its history has that exact prefix and proven answer, and when the
retained browser tab exposes the exact prior prompt marker. New images are attached only with the
delta; the full reset fallback retains every currently relevant attachment.

Forks receive a new task key. Resume can continue after a daemon restart when the digest ledger and
browser surface both survive. Compaction replacement, launcher restart, LRU eviction, missing
output, or any local/browser digest mismatch selects a fresh Temporary Chat with the complete
current context. If that full reset exceeds the measured transport ceiling, the request fails and
requires Codex compaction; it is never truncated silently. The runtime does not create a context
JSONL file or upload a synthetic context document. Attachment acceptance, exact composer readback,
submission evidence, and completed-turn evidence remain mandatory before acknowledgement.

The worker reports the transport selected after retained-marker verification to the authenticated
launcher control channel. The task tab displays `FULL`, `DELTA`, or `STATELESS`; local activity also
records a bounded reset reason, never prompt or answer content. Completed task surfaces expire after
two idle hours, while a running surface remains protected by its existing owner/heartbeat lease.

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.

Routed compaction v1/v2 runs as a dedicated read-only browser summarization turn with no broker or
local tools, then returns the native replacement-history shape expected by Codex. A prompt-level
checkpoint marker is translated into a visible Codex trace item; every later tool action in the
same turn continues to present the current turn capability. Visible ChatGPT status rows become
reasoning summaries, while stable prose between rows becomes native Codex commentary.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no installed Chrome/Chromium or system Node/Bun;
sign-in and model turns both remain in Electron. Full mode separately downloads the official pinned
`openai/tunnel-client` build for the current OS/architecture and verifies it against the release
SHA-256 manifest.

On first launch, the embedded runtime is identity-checked and copied atomically into a private
versioned directory under the application home. Daemon and MCP commands use that durable copy,
which is required because Linux AppImage mount paths are temporary and must never be persisted in
Codex or tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the optional
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Native login items or an owner-local XDG autostart file launch the app
hidden after sign-in. A marker containing only launcher-owned PIDs lets doctor distinguish the
launcher runtime from a stale or external process. Legacy macOS launchd services are drained and
removed during an explicit launcher migration; launchd remains only for the advanced terminal-only
mode.

Setup keeps Codex's built-in `openai` provider and switches only `openai_base_url`. The daemon
forwards the authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed. While the integration is active, native
models that support delegation and routed Web models share Codex's readable V1 collaboration
surface so an explicitly selected Web subagent receives plaintext task content. An explicit native
`disabled` delegation capability is preserved. Model choice, effort, context, and service tiers are
otherwise unchanged.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses HTTP requests, including native compaction passthrough;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. The launcher then stops the
tunnel through its runtime command and asks the daemon to flush state and exit through an
authenticated shutdown endpoint. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible. An
unexpected child exit is recovered with a bounded restart budget; a crash loop becomes an explicit
launcher error.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Default automatic browser retries to zero. Explicit non-rate-limit retries have a bounded count
  and exponential backoff; a ChatGPT rate limit never sends another automatic message.
- Serialize account-scoped browser-send reservations with a configurable minimum interval. Persist
  a bounded cooldown after a real `429`; a request seen during cooldown fails immediately rather
  than waiting to send later.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
