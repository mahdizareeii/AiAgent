# Free Local Agent

**Your AI. Your machine. Your freedom.**

Free Local Agent is an open-source desktop AI agent for chat, coding, research,
and documents. It runs a free model on your own computer, using a bundled
inference engine. You choose the model, the project, and the tools it can use.
File edits and terminal commands wait for your approval.

No hosted model account, API key, subscription, Ollama, or separately installed
model server is required. Model weights are a separate download or local GGUF
import. Once a compatible model is installed, chat and local file work can run
offline.

**Current version: 0.2.0-alpha.1.** macOS Apple Silicon is the tested platform.
Windows and Linux packaging/CI is configured; native validation is still pending.

![Free Local Agent home screen with local model status and conversation controls](docs/screenshots/free-local-agent-home.png)

*The home screen, captured from the running desktop app.*

## What Free Local Agent does

- **Chat locally.** Assistant, Coding, and Research modes use the same locally
  stored conversations. Responses come from the model running on your machine;
  tool-capable models stream replies, while chat-only imports return completed replies.
- **Work with a project.** Search selected project files, propose edits, run
  approved terminal commands, and restore file snapshots with per-chat undo.
- **Read larger documents gradually.** Text, code, Markdown, and text-based PDFs
  are read in bounded stages and summarized with source references. Progress,
  cancellation, and local read checkpoints help manage longer tasks.
- **Choose a model for this computer.** Hardware detection and model cards explain
  memory fit, quantization, download size, licenses, and tool compatibility.
  Optional calibration checks tool calling and measures generation speed.
- **Control the utilities.** File reading, project search, editing, terminal
  commands, and web research have individual controls. Web research is off by
  default.

![Free Local Agent conversation workspace showing a local chat and its model status](docs/screenshots/free-local-agent-chat.png)

*A local conversation in the running app.*

## Models and hardware

![Free Local Agent model setup showing detected hardware, model choices, fit assessments, and download or import controls](docs/screenshots/free-local-agent-models.png)

*Choose a pinned catalog model or import a compatible GGUF file.*

| Model | Quantization | Approximate download | Estimated working memory |
| --- | --- | --- | --- |
| Qwen3.5 4B | Q4_K_M | 2.7 GB | 4.5 GiB |
| Qwen3.5 9B | Q4_K_M | 5.7 GB | 8 GiB |
| Gemma 4 12B | QAT Q4_0 | 7.0 GB | 10 GiB |
| Gemma 4 26B A4B | QAT Q4_0 | 14.4 GB | 19 GiB |
| Gemma 4 31B | QAT Q4_0 | 17.7 GB | 23 GiB |

Catalog artifacts have pinned revisions, checksums, and license metadata.
Downloads support cancellation and resume, and the app verifies their SHA-256
before use. Four-bit quantization reduces storage and memory with a precision
tradeoff. These working-memory values are planning estimates, not measured peaks;
the app also reserves room for the operating system and considers available
memory and accelerator placement.

Model cards classify fit as **Recommended**, **Slow mode**, or **Insufficient
memory**. Slow mode can use CPU or partial GPU offload and a smaller context.
Staged processing reduces the context needed for large documents and long chats;
the model weights must still fit usable memory. A smaller active parameter count
in an expert model does not eliminate its stored weights.

Imported models start with chat capabilities. Agent tools require a supported
architecture/template and passing native tool calibration. A chat-only model can
still process attached files through the app's local reading stages.

## Your tools, your approval

![Free Local Agent utility settings explaining file reading, project search, editing, terminal access, and optional web research](docs/screenshots/free-local-agent-tools.png)

*Utility controls explain what each tool accesses and when approval is required.*

| Utility | Access and behavior |
| --- | --- |
| File and PDF reading | Reads files you attach or grant; works in every mode. Text PDFs only. |
| Project search | Searches the selected project in Coding mode. Read-only searches need no per-action approval. |
| File editing | Proposes project changes in Coding mode. Each write needs approval; saved file snapshots support undo. |
| Terminal commands | Shows the proposed command in Coding mode and asks for approval each time. Commands run as your operating-system account. |
| Web research | Available in Research mode only when enabled. Searches and public-page fetching use the internet. |

Disabled web tools are excluded from tool registration. Approved shell commands
can still access the network and files beyond the project; they have your account's
permissions and are not OS-sandboxed. Undo restores file snapshots and cannot
reverse terminal-command side effects. Resume verifies read checkpoints against
source hashes and never automatically repeats an agent edit or command.

## Get started

For a packaged macOS build, unzip `Free Local Agent-0.2.0-alpha.1-arm64-mac.zip`, move
`Free Local Agent.app` to Applications, and open it. Apple Silicon and macOS 13.3 or newer are
required. This alpha is unsigned and not notarized.

1. Open **Models & setup** and review your detected hardware.
2. Download a model that fits, or **Import GGUF** from a local file.
3. Select the model; optionally run **Check tools & speed**.
4. Choose utilities, select a project or attach files, and start a conversation.
5. Review each proposed edit or command before approving it.

See the [setup and developer guide](docs/setup-guide.md) for detailed setup,
source builds, packaging, storage locations, and permission boundaries.

## How local is it?

Free Local Agent bundles **llama.cpp v0.6.0** and a source-built **Goose v1.53.0** backend
with online model metadata, telemetry, and update features disabled. The app owns
the inference process and connects through an authenticated loopback endpoint.
Inference stays on the selected local model; there is no cloud-provider fallback.
End users do not need Python or Rust installed.

Model downloads and source dependency preparation need the internet. A local
GGUF import does not. Enabled web research, external links, and approved network
commands can use the internet. Chats, imported models, checkpoints, command logs,
and edit snapshots are stored locally. The legacy `Local Agent` data-folder name
is retained to preserve existing installations. The app adds no disk encryption.

## Validation and current limits

On a **24 GB Apple M5**, Qwen3.5 4B passed real local chat, native tool calling,
token counting, and a Goose/MCP file-read smoke with public networking blocked.
Separate short native and earlier Local Agent packaged-app calibrations measured
**30.8–37.5 tokens/sec**. These measurements are not a broad model-quality or peak-memory
benchmark. See the [measured compatibility report](docs/compatibility-report.md).

The implementation passed **81 JavaScript/TypeScript tests**, **59 research
tests**, and **5 frozen-sidecar protocol tests**, plus the macOS packaged smoke.
The [verification report](docs/build-verification.md) describes what was tested,
including the distinction between network-denied native tests and normal GUI
checks.

This alpha supports text, code, and text-based PDFs. OCR/scanned PDFs, vision,
audio, CUDA-specific acceleration, browser/desktop automation, signed installers,
and automatic updates are deferred. Windows/Linux native runs, broader catalog
benchmarks, long-context peak memory, and the
[task-quality rubric](docs/alpha-validation.md) remain pending. Summaries can omit
details, and model answers or tool proposals can be wrong.

## Source and licenses

The source is available on [GitHub](https://github.com/mahdizareeii/AiAgent).
Build instructions are in the [developer guide](docs/setup-guide.md). The desktop
uses Electron/React, the agent backend uses Goose, and the research utilities run
in a bundled native sidecar. See [architecture and boundaries](docs/architecture.md)
for the runtime, tool, and storage design.

Application code is [Apache-2.0](LICENSE). Bundled dependencies retain their own
licenses, including llama.cpp's MIT license; see [NOTICE](NOTICE). Model weights
are separate artifacts governed by their published licenses. The current catalog
records Apache-2.0 for each pinned model artifact.
