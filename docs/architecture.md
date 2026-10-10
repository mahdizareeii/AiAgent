# Architecture and trust boundaries

Free Local Agent 0.3 uses a custom Electron/React desktop, the Goose v1.53.0 agent
engine, a bundled llama.cpp server, and a native research/file sidecar. Goose is
built from the vendored source with default features disabled and only
`rustls-tls,disable-update`; online model metadata and telemetry features are not
included. Source and binary hashes are recorded in resource manifests. No model
weights are bundled.

```mermaid
flowchart TD
  UI[React renderer] -->|typed context bridge| MAIN[Electron main process]
  MAIN --> HARDWARE[Hardware fit and local model management]
  MAIN --> STAGES[Bounded read and summary stages]
  STAGES --> CHECKPOINT[Local hash-validated checkpoints]
  MAIN -->|ACP stdio| GOOSE[Offline Goose build]
  GOOSE --> GATEWAY[Local token-budget gateway]
  STAGES --> GATEWAY
  GATEWAY -->|loopback| ENGINE[Bundled llama.cpp server]
  ENGINE --> WEIGHTS[Verified local GGUF]
  GOOSE -->|MCP stdio| READS[Bundled file and research tools]
  READS --> GRANTS[Selected files and project]
  READS -->|explicit web enablement| WEB[DuckDuckGo and public pages]
  GOOSE --> APPROVAL[Main-process approval bridge]
  APPROVAL -->|Approve once| ACTIONS[File edits and terminal commands]
```

## Inference and model fit

The renderer has no Node integration or direct inference/network API. Main-process
IPC validates user operations; models cannot choose IPC methods, executable paths,
arbitrary providers, or tool permissions. Raw HTML is not rendered and renderer
connections are blocked by CSP. External links open in the system browser.

The bundled engine is pinned llama.cpp v0.6.0/build 11429, with official binary
archive SHA-256 values, license text hashes, and a full regular-file inventory.
Native validation checks its version and required offline/control flags. Packaging
preserves the inference manifest and validates the actual bundled resources.
macOS uses Metal or CPU; Windows/Linux include Vulkan and CPU backends. System GPU
drivers remain external dependencies. Windows preparation includes signed Visual
Studio redistributable runtime DLLs, and Ubuntu packages declare required runtime
libraries, including `libc6 >= 2.34` and `libstdc++6 >= 12` (GLIBCXX 3.4.30).
These version floors match the audited executable and bundled native libraries.
The app owns its loopback inference child and does not use Ollama.

Hardware detection combines system memory, available memory, CPU/GPU information,
and free storage. Working-memory estimates reserve room for the operating system
and classify models as recommended, slow, or insufficient. Slow mode permits a
bounded CPU/offload profile; it does not shrink weights or permit a model beyond
the hardware budget. A small active-parameter count in an expert model still
requires all stored weights. The four-bit catalog variants lower weight precision
to reduce storage and memory, with a quality tradeoff. Read stages reduce context,
not weight memory. Calibration checks native tool calling and measures this
computer's generation speed; task quality remains a separate manual evaluation.
Model cards disclose weight, 8K-context, scratch, operating-system reserve, and
system/GPU budget components. The loaded profile reports its actual context
capacity; these components remain estimates rather than observed peak memory.

Curated downloads use pinned publisher revisions and file SHA-256 values, bounded
approved artifact hosts, resumable partial files, and verified completion before
activation. GGUF import hashes the local file and validates bounded metadata,
architecture, and embedded chat template; unsupported variants can be rejected.
Imported models have their own publisher/license responsibility and start as
chat-only models. Native template support and a passing local tool-call probe are
required before tool use is enabled. A curated model's declared capability is
also provisional until its native template and calibration pass; a failed probe
leaves chat available with agent tools disabled. Calibration results are currently
held in memory for the runtime session and do not survive its restart.
Inference is local and offline. First catalogue downloads require the internet;
copying an imported local GGUF does not. Explicitly enabled web tools are separate.

## Context, stages, and resume

A local gateway serializes model calls and asks the engine to count the templated
input tokens. It reserves output capacity and a safety margin. Older completed
exchanges can be summarized locally to make space; active instructions and current
tool context must remain intact. If required context still does not fit, the task
fails with a smaller-request/model-choice path. Allocation failures have a bounded
lower-profile retry; this is not a guarantee that a large model can load.

Attached text/PDF sources are inspected for hashes, then read using bounded
continuation cursors, including long lines and long PDF pages. Each excerpt is
summarized with source locations, and summaries are reduced sequentially before
agent execution. Large pasted requests also use bounded stages. These summaries
are lossy; exact facts may require additional reads from the original source.

Checkpoints persist the request, model digest, source hashes, read cursors, summary
progress, and phase in application data. Pause/restart can resume **read-only**
stages only after validating those identities. Changed sources/models invalidate
old summaries and restart reading. Agent action phases cannot resume or replay
edits and commands automatically. An interrupted agent turn needs a new request.

The app keeps full displayed transcripts locally. Each turn starts a fresh Goose
ACP session using temporary backend configuration, cleaned after the turn. Recent
conversation context is bounded; seeing an old message in the UI does not imply
that all of its detail is in the next inference request. Stage checkpoints and
edit snapshots are independent durable app data, not a resumed Goose database.

## Tool preferences and action review

The user chooses file reading, project search, file editing, terminal, and web
research. **Web research defaults to false.** Disabled tools are omitted from the
MCP tool list, including network tools. Modes and model tool support further
constrain the offered capabilities. File reading works in every mode, project
search/editing/terminal only in Agent, and web tools in Agent and Research when
enabled. Chat never registers network tools, including when a saved preference
is true; the sidecar enforces that mode boundary too. A chat-only
model still uses enabled read stages for attachments but bypasses Goose and agent
tools for the final response. The research sidecar exposes `inspect_file`
alongside enabled file reads; inspection returns a hash/size, not document text.

Agent and Research turns load the app-owned `task-research/SKILL.md` from the
packaged ASAR before starting Goose. The loader validates identity and size;
external Goose skill discovery remains disabled. These instructions guide
version-aware primary-source research, bounded findings, and implementation
with the existing approval tools. The complete skill enters native token counting
alongside the request and tool schemas. Web-disabled turns cannot register web
tools, and the skill forbids network research workarounds. Chat-only imports
receive local-context instructions and never advertise tools they cannot call.

Edits and commands require a decision for each pending action in main. The UI shows
arguments and a diff or command. Denial leaves the action unexecuted; approval
applies once. Unknown/consumed requests cannot grant later access. Writes are
bounded to the selected project and have pre-edit snapshots. Saved coding chats
restore their per-chat undo history.

**Terminal commands are not OS sandboxed.** An approved command runs as the user's
account; its project working directory does not constrain access to other files,
subprocesses, or networks. Read/write grants do not constrain approved commands.
Undo cannot reverse command side effects or concurrent changes by other programs.

## Read, network, and storage boundaries

Selected files grant those exact files; project grants allow bounded traversal
below their canonical root. Reads deny parent traversal, symlink/junction escapes,
common credentials, and credential directories. These checks are not a complete
secret scanner and do not isolate another program running as the same OS user.
PDF extraction runs in a cancellable resource-limited worker; scanned/encrypted
PDFs and Office formats remain unsupported. See the
[sidecar contract](../local-agent/research/README.md) for exact size/time limits.

Enabled research sends queries to DuckDuckGo and requests public pages. Fetching
validates public DNS answers and redirects, disallows credentialed/private URLs,
and bounds response sizes/time. It does not execute JavaScript or carry browser
cookies. Documents and pages are untrusted data; their instructions cannot grant
tool permissions. External links, model downloads, and approved commands can also
use the network even though inference stays local.

Web results record tool-generated UTC observation timestamps separately from
publisher/server date claims. Fetches retain the requested and final URLs, a
SHA-256 of normalized source text, and bounded unverified metadata. A declared
canonical URL never replaces the fetched citation URL or initiates a request.
Metadata and excerpts share the serialized tool-result budget; pagination offsets
reflect the excerpt actually returned. A hash change between pages signals a
changed source. Search snippets provide discovery rather than verified releases.

Chats, model files, imported-model records, checkpoint excerpts/summaries, and edit
snapshots persist in the app's userData directory. The app adds no disk encryption.
Users should grant only material they intend the local model to process and rely
on operating-system account/storage protection for local data.

## Validation and distribution

Tests of fake providers and mocked networks establish protocol/permission behavior,
not actual model competence, GPU allocation, or complete-agent speed. Native
resource smoke tests validate pinned offline manifests, engine version, packaged
MCP controls, and denied writes without loading an LLM or contacting a public site.
See [current verification status](build-verification.md) and the
[real-model rubric](alpha-validation.md).

macOS arm64 ZIP, Windows x64 portable ZIP, and Ubuntu x64 DEB jobs are configured.
Windows/Linux native jobs have not been executed locally. The macOS app is unsigned
and not notarized; alpha packages use manual updates and artifact checksums. CI has
read-only permissions and does not publish releases or hold signing credentials.
