# Free Local Agent setup and developer guide

This guide describes **0.5.0-alpha.1**. The app bundles local inference, an offline
Goose backend, and file/research utilities. Weights are downloaded or imported
separately. Actual platform/model results and delivery hashes live in the
[alpha.5 validation report](alpha5-validation.md); previous reports retain their
original scope.

## First launch

Unzip the Apple Silicon package listed in the report, then open
`Free Local Agent.app`. The alpha is unsigned and not notarized. Normal inference
requires macOS 13.3 or later; the experimental SSD worker requires **macOS 14 or
later, Apple Silicon, and a local APFS model volume**. Windows/Linux retain normal
CPU/Vulkan inference and await native SSD validation.

1. Open **Models**. Model cards come first; hardware and diagnostics are under
   **Advanced**. An empty profile shows onboarding rather than an engine error.
2. **Download** acquires pinned, checksummed weights if storage permits. Memory
   fit does not prohibit downloading. Alternatively, use **Import GGUF**. Select
   all four exact curated shards together for Qwen3-Coder-Next; a single shard
   cannot be used independently.
3. **Use** selects a usable normal model. A supported installed MoE also offers
   **Try from SSD**, which verifies the model set and probes the separate worker.
   It can be much slower and can stop when current memory is unsafe. A failed or
   cancelled trial restores the preceding usable configuration and keeps drafts.
4. **New task** is the primary workflow. Use the single **Workspace** control to
   choose a folder or create a new child folder. Describe the result; planning,
   implementation, checking, and bounded repair run automatically.
5. Review each proposed edit or terminal command. **Approve once**, **Deny**, and
   **Stop** retain their normal boundaries. Expand **Working** with the mouse,
   Enter, or Space to inspect supplied thinking, tools, inputs, and results.
   A model that supplies no thinking shows its actual tools and progress.

**New chat** starts an ordinary conversation with no file mutations or terminal
commands. Local attached text/PDF reading is available when enabled. Completing
model setup enables sending in the same window without restarting. Setup retains
the current unsent draft and attachments; this does not promise draft persistence
across application quit.

## Model evidence and prerequisites

Coding, Websites, Automation, Documents, and Research icons describe intended
uses. Python, JavaScript, React, Node.js, and WordPress are software examples,
not passed compatibility certifications. Development tools, Docker, databases,
package managers, and internet access may be separate prerequisites. A model's
publisher guidance is distinct from local weight integrity, a successful Chat
probe, valid tool format, and actual task checks. Failed and unverified checks
remain visible.

**Measure speed & tool format** and **Validate model for tasks** are under
Advanced. Speed calibration measures this profile's generation speed; task
validation uses a small exact-file workflow with normal approvals. A passed
fixture does not establish universal correctness. The release report separately
records file and CLI checks, including retained failures and blockers.

## Larger MoE models from SSD

The separate SSD worker reads cold routed experts into a bounded cache. Attention,
routers, shared experts, context state, and working buffers stay resident. It
preserves quantized values and executes every expert selected by the model. It
requires all expected routed groups to be streaming; full-weight fallback is
rejected. Gemma uses at least 24 slots per layer; Qwen uses at least 30. Dense
models are not supported by this experimental route.

The initial profile uses one model/context/slot, 4K context, 1K output allowance,
64 batch, 16 microbatch, F16 context cache, and two bounded I/O workers. Only
validated descriptor-local macOS cache bypass is accepted. CPU is the initial
backend; production Metal activation requires evidence bound to the model,
template, engine inventory, profile, and numerical comparison. A synthetic Metal
fixture alone does not validate a complete language model.

The runtime unloads the preceding owned model before measuring a trial. It
reserves at least 2 GiB or 20% of RAM for the OS and requires additional available
memory headroom. Cache, resident weights, context/recurrent state, scratch,
staging/uploads, and process overhead have separate allocation guards. Physical
footprint, RSS, available memory, and pressure are sampled every two seconds,
without counting Apple unified memory twice. Cancellation, missing monitoring,
unsafe memory, and deadlines stop the owned worker. Sampling is not a hard
instantaneous OS memory guarantee. Swap settings and unrelated processes are
never changed.

Loading and shared Chat/tool probing each have a 30-minute deadline. New SSD
tasks receive **four active hours**, extendable to **eight** under Advanced before
creating the task. Normal new tasks and migrated tasks retain their one-hour
budget. Tasks keep 40 model steps and three repair cycles; approval waits pause
the execution clock but still expire. A terminal command's displayed time limit
remains the limit approved for that command. Stop/expiry preserve completed
actions; an explicit new request is needed, without automatic action replay.

## Utilities and plugins

**Tools** controls local file reading, **Find files & text**, editing, and terminal
commands. Research and internet permission are only in **Plugins**, off on a fresh
profile. Disabled web tools are omitted from registration. Enabling research
allows public-source lookup; inference still stays on loopback. Approved terminal
commands run with the user's permissions and can access the network.

File edits use exact UTF-8 content and verified mutation receipts. New files and
edits have local undo records. Undo cannot reverse package installation, database
changes, command side effects, or concurrent external modifications. Complete
command output stays local and supports paged excerpts. See the
[architecture and trust boundaries](architecture.md).

## Data and migration

The public name is Free Local Agent; the retained data-folder name is `Local Agent`
so upgrades preserve chats, models, workspace paths, attachments, downloads, and
undo. Normal locations are `~/Library/Application Support/Local Agent`,
`%APPDATA%/Local Agent`, and `~/.config/Local Agent` (subject to XDG settings).
An explicit `--user-data-dir` starts an independent profile whose storage location
is displayed. Profiles are not automatically merged or copied.

State version 5 stores text scale, execution preferences, and task budgets. Old
tasks retain their prior approach and one-hour budget. Historical mmap disk trial
results remain historical; they cannot validate the new SSD engine. New native
trial consent and model evidence are bound to verified weights, template,
profile, and the entire worker/library inventory. A restart must verify and
prepare that binding before execution. No model switch is permitted during a task.

Text uses native system fonts: conversation/composer 15 px, code/thinking 14 px,
and controls 13 px. **Text size** persists from 90–125%. A selected workspace and
saved messages are independent of the current model selection.

## Build from source

Source builders need Node.js 24.10+, Python 3.12, Rust **1.96.1**, CMake, and native
C/C++ tools. macOS needs Apple Command Line Tools; Windows needs Visual Studio C++
Build Tools and redistributables. Ubuntu 24.04 needs its normal build toolchain,
`libgomp1`, `libc6 >= 2.34`, `libstdc++6 >= 12`, and `libvulkan1`. GPU drivers are
system dependencies. Packaged users do not install a separate model server.

From the repository root on macOS/Linux:

```sh
npm ci
rustup toolchain install 1.96.1 --profile minimal
export RUSTUP_TOOLCHAIN=1.96.1
python3.12 -m venv local-agent/research/.venv
local-agent/research/.venv/bin/python -m pip install -r local-agent/research/requirements-lock.txt -r local-agent/research/requirements-dev.txt
npm run prepare:backend
npm run prepare:inference
npm run prepare:research
# On Apple Silicon only:
npm run prepare:ssd
npm run build
LOCAL_AGENT_REQUIRE_INTEGRATION=1 npm run check
local-agent/research/.venv/bin/python -m pytest -q local-agent/research/tests
npm start
```

On Windows, use `py -3.12 -m venv`, the virtual environment's
`Scripts/python.exe`, and set `$env:RUSTUP_TOOLCHAIN = '1.96.1'`. Skip
`prepare:ssd`; the Mac-only worker is not a Windows dependency.

The normal engine is pinned llama.cpp v0.6.0/build 11429. The SSD build applies a
tracked backport to commit `d81235049384534c167caea52b85a694f6103d14`, inventories
all native files, and retains source licenses. Build details, safeguards, and
synthetic fixtures are in [SSD worker build notes](../scripts/ssd-inference/BUILD.md).
Use `node scripts/prepare-ssd-inference.mjs --verify` to validate the generated
worker without rebuilding. Unknown preparation flags are rejected.

Goose v1.53.0 builds with `--no-default-features --features rustls-tls,disable-update`;
online metadata and telemetry are excluded. Python utilities freeze into a native
sidecar. Preparation requires the internet; local runtime operation does not.

Run `npm run package` and `npm run smoke:package` natively on the target OS.
The configured [CI](../.github/workflows/alpha.yml) builds SSD resources only on
Apple Silicon, then checks resources and approval boundaries. A configured job
is not evidence of a successful native release. Current repository changes and
packages stay local; no GitHub push or publication is performed.

Application source is Apache-2.0. Goose, llama.cpp, Python and Electron dependencies
retain their licenses and notices; model weights have separate publisher licenses.
See [NOTICE](../NOTICE). OCR, vision, audio, CUDA-specific acceleration, signed
installers, automatic updates, and arbitrary desktop automation are deferred.
