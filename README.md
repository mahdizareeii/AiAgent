# Local Agent

An open-source desktop alpha for coding, research, and documents with models
running on your computer. Version **0.2.0-alpha.1** bundles the llama.cpp inference
engine and builds Goose with online model metadata disabled. End users do not
install Ollama, Python, Rust, or a separate model server. Model weights are a
separate download or a compatible GGUF import. Catalogue downloads require the
internet; an imported local file does not. After setup, local chat and file work
can run offline. No model API key is required.

Real Qwen3.5 4B chat, native tool calling, and a Goose/MCP file-read smoke passed
on Apple M5. Short native and packaged-app tool calibrations measured
**30.8–37.5 tokens/sec**; see the [compatibility report](docs/compatibility-report.md)
for the distinct runs. Broader task quality and peak-memory behavior still need
the [validation run](docs/alpha-validation.md). Windows and Linux native CI is
configured; it has not been executed locally. See
[build verification](docs/build-verification.md) for the distinction between
current checks and earlier alpha results.

## What the app provides

- Hardware detection shows CPU, system memory, free storage, and supported GPU
  backends. Model cards show fit, quantization, license, estimated working memory,
  potential tool support, source, and optional measured tokens per second.
  Expand a card's memory estimate to see weights, 8K context, scratch space,
  operating-system reserve, and system/GPU budgets separately. The loaded runtime
  profile shows its current context capacity, which may be lower after fallback.
- Download a pinned GGUF model with progress, cancellation, retry, and SHA-256
  verification; or import a compatible local GGUF. Calibration checks local tool
  calling and measures generation speed. Fit estimates are provisional until a
  model loads and runs.
- Choose tools individually: file reading, project search, file editing, terminal,
  and web research. **Web research is off by default.** Edits and terminal commands
  require approval for every action. File changes have snapshots for undo per chat.
- Large attached documents and long requests are read and summarized in bounded
  stages, with visible progress and local checkpoints. Paused read-only stages
  can resume after verifying the model and source hashes. Agent edits and commands
  are never automatically replayed by Resume.
- Coding, Research, and Assistant chats share local conversation storage. Text,
  code, Markdown, and text-based PDFs are supported. Web research uses DuckDuckGo
  and public pages and therefore uses the internet when explicitly enabled.

The catalogue includes Qwen3.5 4B/9B and Gemma 4 12B/26B A4B/31B:

| Model | Quantization | Download | Estimated working memory |
| --- | --- | --- | --- |
| Qwen3.5 4B | Q4_K_M | 2.7 GB | 4.5 GB |
| Qwen3.5 9B | Q4_K_M | 5.7 GB | 8 GB |
| Gemma 4 12B | QAT Q4_0 | 7.0 GB | 10 GB |
| Gemma 4 26B A4B | QAT Q4_0 | 14.4 GB | 19 GB |
| Gemma 4 31B | QAT Q4_0 | 17.7 GB | 23 GB |

Sizes are approximate and working memory includes a context/scratch estimate.
Hardware fit also reserves memory for the operating system and other programs.
A four-bit model stores its weights at lower precision than full-precision weights,
reducing memory and storage with a quality tradeoff. Catalogue sizes and fit are
estimates, not measured peak memory or a completed performance benchmark.
A model's smaller active parameter count does not reduce all its stored weights.
Slow mode may use CPU/partial GPU offload and smaller context. It does not make
an oversized model fit by reducing its weights; choose a smaller model when the
app reports insufficient memory.

## First launch

On macOS Apple Silicon, unzip the macOS arm64 archive, move `Local Agent.app` into
Applications, and open it; the runtime is included and model weights are downloaded
or imported separately.

1. Open **Models & setup** and inspect the detected hardware and bundled runtime.
2. Choose a model that fits, then **Download model** and **Use model**. Alternatively,
   choose **Import GGUF**. Compatible GGUF architecture and chat-template metadata
   are required; unsupported files or variants can fail validation. An imported
   model starts in chat-only mode. Agent tools are enabled only after the runtime
   confirms native tool support and a local calibration passes.
3. Optionally **Check tools & speed**. This checks native tool calling and measures
   generation speed, not complete agent-task quality. Enable **Allow slow mode** only if you
   accept slower CPU/offload operation for a model classified as slow.
4. Choose tools, select a project for Coding, and attach the exact local files you
   want processed. File reading works in every mode; project search, edits, and
   terminal commands work in Coding; web tools work in Research after you enable
   web research. A chat-only model can process attached files through local read
   stages, but cannot call agent tools.
5. Review proposed edits/commands and **Approve once** or **Deny**. **Stop** cancels
   the task. **Resume task** appears for a paused read-only checkpoint. An
   interrupted agent turn needs a new request; Resume does not replay its actions.

The inference process is app-owned and bound to loopback. It runs in offline mode,
without the engine's web UI or agent tools. The app does not use an existing
Ollama cache/service or fall back to a cloud provider. Downloads, enabled research,
external links, and approved network commands still use the internet.

## Build and run from source

Use native macOS Apple Silicon, Windows x64, or Ubuntu 24.04 x64 with Node.js
24.10+, Python 3.12, **Rust 1.96.1**, and CMake. macOS needs Apple command-line
build tools; Windows needs Visual Studio C++ Build Tools and its redistributable
files. Ubuntu needs standard C/C++ build tools and the runtime libraries
`libgomp1`, `libc6 >= 2.34`, `libstdc++6 >= 12` (GLIBCXX 3.4.30), and `libvulkan1`
for optional Vulkan acceleration. These native version floors were checked across
the bundled Linux executable and libraries; Ubuntu 24.04 provides them.
The inference binaries are pinned official builds; no Vulkan SDK or GPU driver
is bundled. Supported GPU acceleration needs the appropriate system driver.

Run from this repository root. Dependency preparation uses the internet and the
Goose Rust build can take substantial time and disk space.

macOS / Linux:

```sh
npm ci
rustup toolchain install 1.96.1 --profile minimal
export RUSTUP_TOOLCHAIN=1.96.1
python3.12 -m venv local-agent/research/.venv
local-agent/research/.venv/bin/python -m pip install -r local-agent/research/requirements-lock.txt -r local-agent/research/requirements-dev.txt
npm run prepare:backend
npm run prepare:inference
npm run prepare:research
npm run build
LOCAL_AGENT_REQUIRE_INTEGRATION=1 npm run check
cd local-agent/research
.venv/bin/python -m pytest -q
cd ../..
npm start
```

Windows PowerShell:

```powershell
npm ci
rustup toolchain install 1.96.1 --profile minimal
$env:RUSTUP_TOOLCHAIN = '1.96.1'
py -3.12 -m venv local-agent/research/.venv
local-agent/research/.venv/Scripts/python.exe -m pip install -r local-agent/research/requirements-lock.txt -r local-agent/research/requirements-dev.txt
npm run prepare:backend
npm run prepare:inference
npm run prepare:research
npm run build
$env:LOCAL_AGENT_REQUIRE_INTEGRATION = '1'
npm run check
Push-Location local-agent/research
.venv/Scripts/python.exe -m pytest -q
Pop-Location
npm start
```

`prepare:backend` builds the vendored Goose v1.53.0 source with
`--no-default-features --features rustls-tls,disable-update`; its manifest records
`offline: true`, feature flags, and the binary hash. `online-model-meta` is excluded.
`prepare:inference` verifies pinned llama.cpp v0.6.0/build 11429 archives, license
texts, and every bundled file. `prepare:research` builds a native Python sidecar.
Source builders need the toolchains; packaged users receive those native resources.
The integration flag prevents tests from silently skipping missing native resources.
Protocol tests use a deterministic local provider and do not establish real-model
competence.

## Data and boundaries

Application data uses Electron's `userData` location: normally
`~/Library/Application Support/Local Agent`, `%APPDATA%/Local Agent`, or
`~/.config/Local Agent` (subject to XDG configuration). It contains chats, model
files, imported-model records, stage checkpoints, and edit snapshots. Speed and
tool-calibration results currently stay in memory for the runtime session and
are checked again after restarting it.
No disk encryption is added by the app. Avoid granting sensitive material you do
not intend the local model to read.

Approved commands run as your operating-system account and can access files or
networks beyond the project directory. There is **no OS command sandbox**. Read
and write tools enforce their own grants; those grants do not constrain an
approved shell command. Undo restores saved file snapshots and cannot reverse
terminal-command side effects. See [architecture and boundaries](docs/architecture.md).

Bounded summaries can omit details. The app stores complete displayed transcripts,
while model requests use a bounded recent context. A local model can produce wrong
answers or malformed tool calls; inspect critical answers and proposed actions.
Scanned PDFs/OCR, encrypted PDFs, Office editing, browser/desktop automation, signed
installers, and automatic updates remain outside this alpha.

## Native packages and licenses

After preparation, run `npm run package` and `npm run smoke:package` on the target
OS. Outputs in `release/` are a macOS arm64 ZIP, Windows x64 portable ZIP, and Ubuntu
x64 DEB. **The macOS alpha is unsigned and not notarized.** Windows/Linux packages
are unsigned, and their native jobs remain configured rather than locally verified.
Do not treat an added CI configuration as a completed release.

[Native CI](.github/workflows/alpha.yml) prepares resources, requires integration
checks, packages the app, runs offline resource/MCP/approval smoke checks, and
uploads packages with SHA-256 checksums. It has read-only repository permissions
and does not publish a GitHub release. PyInstaller packaging runs natively on each OS.

Application code is [Apache-2.0](LICENSE). Goose retains its upstream license and
notices. The bundled llama.cpp engine is MIT; its pinned license texts accompany
inference resources. Python dependency licenses accompany the research sidecar.
[NOTICE](NOTICE) identifies principal dependencies. Model weights are separate
artifacts governed by their own published licenses.
