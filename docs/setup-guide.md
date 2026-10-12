# Free Local Agent setup and developer guide

Free Local Agent **0.4.0-alpha.4** runs local models through a bundled llama.cpp engine. The
packaged app includes the native inference engine, offline Goose backend, and
research sidecar; model weights are downloaded or imported separately. Start
with the [project overview](../README.md) for features, screenshots, and current
platform support.

This guide describes the alpha.4 R7 macOS ARM64 package. It passed 315 automated
checks under macOS-enforced public-network denial, TypeScript, offline packaged
smoke, 94 Python source tests, and 8 frozen
sidecar protocol tests. Native Qwen calibration measured 28.9 tokens/sec on
Metal with 8K context. Its app-applied Node CLI repair passed four independent
input checks and shows its completed answer/readback. Fresh file and ordinary
Chat checks also passed: exact approved create/read/edit/read, read-only retained
file text, and visible `42` with zero tools/approvals. Reopening restored that
Chat, its mode and 125% text setting. Empty/regular-profile verification remains
pending.
The verified Gemma download reached an explicit final R7
experimental load, which the app stopped at its sampled resident-memory budget
before Chat or tool probes. The preceding R4 failed the Qwen validation and Node
CLI task, including an outcome-classification defect. See the
[draft report](alpha4-validation.md) for artifact identity, retained failures,
narrower passes, and pending empty/regular-profile checks. Screenshots and records retain
their original payload scope.

## First launch

For an available local macOS Apple Silicon package, check the payload in the
[validation report](alpha4-validation.md), then unzip
`release/alpha4-delivery/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip`, move `Free Local Agent.app` into
Applications, and open it; the runtime is included and model weights are downloaded
or imported separately.

1. Open **Models & hardware** and inspect the detected hardware and bundled runtime.
   **Preparing local engine…** is normal during initialization. An empty model
   library shows **Download or import your first model**, rather than an engine error.
2. Choose a model that fits, then **Download model**. The first successful download
   is selected automatically; use **Use model** to select an existing downloaded model. Alternatively,
   choose **Import GGUF**. Compatible GGUF architecture and chat-template metadata
   are required; unsupported files or variants can fail validation. An imported
   model starts in chat-only mode. Agent tools are enabled only after the runtime
   confirms native tool support and a local calibration passes.
3. Optionally **Measure speed & tool format**. This checks native tool calling and
   measures generation speed. **Validate model for tasks** is a separate small
   Agent workflow with normal approvals; neither check guarantees general task
   quality. Keep **Automatic** memory mode initially, or choose **Low memory**
   for smaller context/batches. Experimental disk requires an explicit trial.
4. Start **New task**. New tasks default to **Agent** mode. Before starting,
   use **Add folder** in the sidebar to choose an existing workspace, or
   **Create folder** to name a new folder and choose its parent in the native
   picker. Enable the tools your task needs. File reading works
   in every mode; **Find files & text**, file creation/editing, and terminal commands
   work in Agent independently of Research. Web tools work in Agent and Read-only
   research after you enable both Research and web access in **Plugins**. Use
   **Chat** for conversation and attached-file reading. A chat-only model can
   process attached files through local read stages, but cannot run Agent tasks.
   Choose **Careful Agent** or **Standard Agent** before creating the task;
   Careful is the initial new-task default, while migrated tasks retain Standard.
5. Review proposed edits/commands and **Approve once** or **Deny**. **Stop** cancels
   the task. **Resume task** appears for a paused read-only checkpoint. An
   interrupted agent turn needs a new request; Resume does not replay its actions.

The neutral, Codex-inspired workspace has a task sidebar, a centered conversation,
and a bottom composer. The composer groups mode, workspace, tool, and
model controls with your message. **Plugins** and **Models & hardware** are in the
sidebar. Use the moon/sun toggle at the bottom of the sidebar to switch light/dark
themes; the preference is saved locally. **Read-only research** appears in the mode
selector when its plugin is enabled. Saved research tasks can still be opened
with the plugin disabled, without reactivating it.

Sidebar **Text size** sets a locally remembered 90–125% text scale, defaulting to
100%. At 100%, conversation text is 15 px, navigation 13 px, and thinking/code
14 px. Text scales without zooming the entire workspace.

## Model setup and recovery

You can draft a task and attach files before a model is ready. **Choose model**
opens setup and preserves both. Downloading, importing, or choosing a verified
usable model enables sending without restarting the app. A later download keeps
an existing valid selection; it replaces a selection whose weights are missing
or fail verification.

If a selected model was removed or changed, verification stops the request before
starting a turn or its tools. The app refreshes model availability and opens setup
when needed, retaining the draft and attachments. Known integrity failures block
the affected model. Use **Download again** for a curated model, or **Import GGUF**
to replace an imported model with a valid file. Successfully verified replacements
clear stale model failures without restarting the engine. Setup never automatically
retries the rejected task, commands, or edits.

Actual engine failures retain their error code and **Retry runtime** action.
**Model library unavailable** means the cache could not be inspected; check its
displayed storage path and permissions, then use **Retry model library**. These
states are distinct from having no downloaded models.

## Memory modes and experimental trials

Choose the mode in **Models & hardware → Memory mode** while no task or model
operation is running. Changing the mode unloads the model and invalidates an
experimental trial. It never restarts a previous task.

| Mode | Behavior and limits |
| --- | --- |
| Automatic | Starts with bounded 8K context, batch 512, and microbatch 128, with supported GPU/CPU profiles. **Allow slow mode** permits a slower supported profile when weights fit. Allocation recovery can reduce batches/context; it never restarts an agent turn. |
| Low memory | Starts with 4K context, batch 128, and microbatch 32, with smaller bounded recovery profiles. Supported slow fits are permitted, but model weights must still fit usable memory. |
| Experimental disk | Explicit macOS ARM64-only CPU trial with mapped weights, 4K context, batch 128, and microbatch 32. A load and inference probe must pass for the exact model/profile before tasks can use it. A new model selection never silently starts this trial. |

To try Experimental disk:

1. Download or import a valid local model. Integrity or unsupported-format errors
   remain hard blocks; experimental mode does not bypass them.
2. Choose **Experimental disk**, then **Try Experimental disk mode** on its card. The original
   **Recommended**, **Slow mode**, or **Insufficient memory** estimate stays visible.
3. Review the loading/probing state and metrics. **Mapped weights** and **Lazy
   eligible** come from engine logs and are distinct from measured **Resident now**.
   Available memory, memory pressure, and resident limit are shown separately.
   Unavailable measurements say **Unknown**, rather than zero.
4. A passed Chat probe permits local inference for that matching loaded
   model/profile. Agent tools also require the native tool-format probe; a failed
   tool probe leaves the model Chat-only. Neither probe proves sustained speed,
   agent reliability, or request completion.
   **Cancel trial** interrupts loading/probing or unloads a passed trial. Failure
   leaves an actionable reason and permits a new explicit Try; no task is replayed.

Experimental protection samples the owned process and macOS memory statistics.
It stops on a sampled resident-budget breach, critical memory pressure, sustained
low available memory, or unavailable monitoring. Sampling can miss short peaks;
this is not an OS-enforced memory cap and cannot prevent every memory-pressure
event. The implementation currently requires macOS Apple Silicon monitoring.
Windows/Linux experimental trials are unsupported. Returning to **Automatic**
retains the separately detected Metal/Vulkan accelerator information; the
experimental trial itself remains CPU-only. Stopped trial values are identified
as last-sampled measurements and distinguish unknown measurements from zero.
The UI currently labels binary-size values as GB; this guide reports them in GiB.

On the 24 GiB Apple M5, the app downloaded and independently verified the
pinned Gemma 4 26B A4B artifact. The final R7 trial stopped experimental loading
when the app's rounded last resident sample and threshold both displayed
**6.86 GiB**. Last available memory was **7.62 GiB**, with normal pressure.
Independent samples confirmed the CPU-only 4K process and its exit. Mapped/lazy
sizes and absolute peak residency remain unknown; no Chat, tool, or task probe
was reached.
That outcome applies to the available memory during this trial, not every 24 GiB
computer. R7's separate Qwen task/Chat evidence does not make this Gemma trial
pass; see the
[record and genuine capture](alpha4-validation.md).

Mapped weights still exist on disk and can be read into RAM. Lazy eligibility
depends on actual tensor layout and can be zero. Disk paging can be extremely
slow. Smaller requests and staged document reads do not shrink model weights.
There is no guarantee that an oversized model becomes usable, or that a free
local model delivers frontier-model quality.

## Validating a model for tasks

**Measure speed & tool format** reports a short local calibration; it is separate
from **Validate model for tasks**. Use task validation with an installed,
tool-capable model and enabled local file-reading/editing utilities. An
experimental model needs its successful explicit trial first.

The button checks ordinary Chat and native tool format, then prepares a scratch
workspace under the app's data directory. The interface selects that scratch
Agent task before sending its request. It asks the model to create
`model-check.txt`, read it, make an exact edit, read the final content, and provide
a nonempty final answer. Each creation/edit still requires normal **Approve
once** or **Deny**. This check uses file tools; it does not require terminal
commands or web research. **Stop** can cancel preparation or the running task.

The recorded result includes Chat, tool-format, exact-edit, exact final-byte
readback, final-answer, and file-only checks. Records retain the model digest,
template hash, pinned runtime, execution-profile identity, and elapsed time.
The UI presents a passed result as current only when the installed model digest,
runtime version, and execution profile match and every recorded check passed.
Older or mismatched records remain visible as historical results. A simple
validation pass is not a guarantee for larger projects or other tasks. The
final R4 Qwen3.5 4B run failed the exact sequence after two model arguments used
literal backslash-plus-`n` instead of the file's LF. The app saved a nonempty
blocked answer and preserved the original approved creation. A separate R4
creation/read/edit/read task passed its actual operations and readback, with a
period-boundary limitation. Final R7's separate exact-file sequence, general CLI
repair and Chat/reopen passed their recorded checks; they do not reclassify the
failed built-in validation. See the [model-specific report](alpha4-validation.md).
Broader model quality remains unverified; the remaining visible delivery checks
are empty-profile onboarding and regular-profile reopening.

## Workspace folders

**Add folder** opens the operating system's folder picker for an existing
workspace. **Create folder** opens a naming dialog, then a native parent-folder
picker. The app creates one new folder under the selected parent and grants
access to that child folder. It does not grant access to the parent. Folder
names cannot contain path separators, control characters, reserved Windows
names, or trailing dots/spaces.

Creation cannot overwrite an existing file or folder. Canceling the native
picker creates nothing and preserves the selected workspace. If saving the
new selection fails after creation, the app keeps your previous workspace and
grants no new access; its error identifies the created folder, which it leaves
untouched. Use **Add folder** later to select that folder if needed.

A saved task keeps its original workspace. **Add folder** and **Create folder**
are unavailable for that task; start **New task** before choosing a different
workspace. Folder selection and creation are also unavailable during a running
task, and the host prevents a task from starting while the picker is open.

## Working details

Click **Working** while a response is running to expand the local model's
thinking, current processing stage, and tool activity. The control is also
keyboard accessible: Tab to it and press Enter or Space. Tool entries can be
expanded to inspect their inputs and outputs. Approval prompts retain their
separate **Approve once** and **Deny** controls.

Expansion persists while thinking and tool results stream. Working reports the
active tool, thinking, processing stage, or waiting approval state. Opening its
details or scrolling up stops automatic scrolling to new output, so you can read
without the conversation moving away.

Thinking appears only when the model emits it. The panel says when thinking
text has not been provided; the app does not construct a reasoning transcript.
Thinking is separate from the answer, bounded to 64 KiB per reply, and stored
locally with the conversation. It can be expanded after completion and restored
when the task is reopened, including partial thinking captured before a stop or
error. Named tool calls, supplied inputs/results, and statuses are saved with
the assistant exchange and restored on reopening. Display history is bounded
to 256 calls and 16 KiB each for input/output, with visible truncation notices.
Processing-stage progress remains transient, and saved activity never replays
a command or edit. See the [current validation record](general-agent-validation.md)
for separate synthetic-renderer, component, and native checks. Mouse, Enter,
and Space activation passed during an actual R7 task; R9 also visibly restored
five named tools after reopening its saved task. The earlier
[alpha.2 Working and folder record](working-folders-validation.md) retains its
original evidence.
This update and its package are kept local and have not been pushed or published
as a GitHub release.

## Standard and Careful Agent

Choose **Standard Agent** or **Careful Agent** in the composer before starting a
new Agent task. The choice stays with its saved task; start **New task** to change
it. Careful is the initial new-task default; choosing an approach also saves the
default for subsequent new tasks. Migrated tasks without an explicit choice
retain Standard. Chat and Read-only research keep their existing mode boundaries.

Standard uses the direct agent workflow with up to 25 agent turns. Careful is
instructed to follow **Plan → Implement → Verify → Repair → Final**, with up to
40 turns and at most three repair cycles after observed failed checks. The host
enforces the repair budget for reviewed actions. Both workflows retain a one-hour
active execution budget after model preparation. Approval waits pause that clock;
the separate ten-minute approval expiry and each approved command's time limit
still apply. More time or steps do not make an inaccurate model reliable.

## Approval recovery and task outcomes

The local host owns pending approvals and their settlement. The interface uses
host snapshots and revisioned events at startup/reconnect, on focus, after a
permission response error, and every five seconds while an approval is pending.
It also binds a restored renderer to the active task and reads its current state.
A missed or late event cannot restore a settled request or dismiss a newer
request; settlement affects only its matching request and turn. Reconnection
never sends an approval, resumes an agent, or repeats an edit or command.

Review the diff or exact command and working directory before **Approve once**.
**Deny** stops further edits/commands in that turn. A cancelled or expired approval
does not authorize the action. Saved command logs and Undo remain available after
the turn stops. Undo restores only applicable file snapshots; it cannot reverse
terminal side effects. Inspect interrupted work before sending a new request.

Each saved assistant exchange can include an outcome and **Passed**, **Failed**,
or **Unverified** operation checks. Expand **Evidence** to read the recorded
details and tool identity. **Recorded checks passed** means the displayed checks
passed; it does not establish that the complete user request was fulfilled. A
successful write to the wrong file, for example, remains a successful operation
receipt rather than proof of a correct task. **Task completed; review checks**
similarly describes a finished turn. Review unverified requirements and actual
files, runtime behavior, or command results before accepting the task result.

If the model ends after tool work without an answer, the host can request one
bounded closing response using recorded evidence with no tools. If that cannot
produce an answer, the app saves an explicit incomplete/blocked notice. This
closing step does not restart the agent or replay completed actions.

## Longer tasks and command limits

The app counts the full templated request, including instructions, tools,
conversation, tool results, and reserved output. It can summarize older completed
conversation and completed local read-only exchanges within a turn. The current
request and latest/pending tool exchanges remain exact. Older completed actions
can become deterministic receipts only when their exact arguments and output
match independently recorded host evidence. IDs, file hashes, error/denial state
and saved command-log references remain; raw activity stays in Working/local
records. Source references let the agent reread files or saved command output.
Summaries are lossy and do not make model weights smaller. If the exact retained
context cannot fit, use a smaller request; the app does not restart the task or
replay its actions to recover context.

Commands default to a 60-second execution limit. For dependency downloads or
other longer setup, the agent can explicitly propose `timeout_ms` up to `600000`
(ten minutes). The proposed command, working directory, and time limit are
included in the normal approval review. This is a general terminal capability,
not a project-specific shortcut.

The local command transport allows up to 25 minutes for approval review and
execution; other native action requests allow 15 minutes. These transport limits
do not extend the command's approved limit, and pending approvals still expire
after ten minutes. A stopped or timed-out command may have made partial changes.
The turn stops rather than automatically rerunning it. Read its saved paged log
and inspect the project before sending a new request to continue.

## Optional Research plugin

The **Plugins** page contains **Research**, an optional bundled workflow backed
by the [task-research skill](../local-agent/desktop/skills/task-research/SKILL.md).
When enabled, it guides Agent and Read-only research tasks to inspect project
versions, resolve changing setup/API requirements, and use the findings while
completing the task. It needs no hosted model account or separate installation.
There is no arbitrary external plugin installer in this version.
Enable Research and grant web access here; the composer has no duplicate Research
switch. **Find files & text** in **Tools** searches only the selected workspace
and is independent of the Research plugin or internet permission.

1. Use a validated tool-capable model. In Agent, choose a workspace.
2. Open **Plugins** and turn on **Enable Research**. It is off by default on a
   new installation. The plugin can use local evidence without internet access.
3. Separately enable **Allow web research** for online sources. It also defaults
   off. Both settings are required for web tools in Agent and Read-only research;
   Chat never registers web tools. No per-read approval is requested for web
   searches and public-page fetches after you grant this permission.
4. Ask for research and implementation together, for example:

   > Check the official documentation and release notes for this project's
   > framework version. Implement this feature using compatible APIs, cite the
   > changes that matter, and run the available checks.

The agent uses public search to discover sources and reads official pages for
evidence. It should cite the fetched URL, relevant version, retrieval date, and
why a finding affects the change. Tool results preserve requested/final URLs,
retrieval timestamps, a content hash, and explicit source date claims when
available. Retrieval time is not a publication date or proof that a page is
current. Missing or conflicting dates should remain uncertain.

With the plugin enabled and web disabled or unavailable, the skill uses local
evidence and identifies changing facts it could not verify. It does not use terminal commands to bypass
disabled research tools. Approved setup/install commands retain their normal
network access and approval requirements. Research does not authorize unrelated
upgrades, automatically update the model, or install app updates. Model quality
still affects how well it follows the skill; verify its findings and actual checks.

Turning off **Enable Research** removes research instructions and web tools from
the next turn. File reading, **Find files & text**, file editing, and terminal controls
remain in **Tools** and work independently. Plugin and web preferences persist
separately; disabling Research retains the saved web permission for your next
explicit enable. Changes are unavailable while a task is running. Legacy version
1/2 settings with explicit web research consent migrate with Research enabled;
version 3 settings missing a plugin toggle default off. Chats, attachments,
selected models, workspaces, and undo records are preserved. See the
[previous 0.4.0-alpha.1 workspace and plugin validation record](workspace-plugin-validation.md).

## Creating a WordPress project

WordPress is an example for verifying the general Agent tools. The app has no
WordPress-specific generator or runtime; the same tools build and validate other
projects.

Use Agent mode for work that creates files or executes commands. An older saved
Chat conversation remains read-only; start **New task** in Agent mode to build a project.
An earlier Qwen4B test created approved files, but its complete WordPress setup
failed validation and did not start a site. A separate two-file theme task passed
file creation, readback, and static checks, but no PHP or WordPress runtime ran.
Review generated configuration and reported checks rather than treating file
creation as successful installation.

An earlier alpha.3 packaged-component attempt was incomplete: normal approvals
created Compose and README files and checked Compose before a later edit hit
output/context limits. A subsequent image download reached the default 60-second
command limit used in that run, and verification was cancelled. That attempt did
not establish an installed site. These historical observations led to the general
command-limit and read-only compaction changes above; they retain their original
scope in the [sanitized task attempts](general-agent-task-attempts.json).

Later guided native R11 app tasks repaired, started, and installed WordPress
through normal approvals. All **12 independent checks** passed, including the
healthy database, installed core, homepage HTTP 200, and actual login form
HTTP 200. One installation executed; its separate read-only postcheck succeeded.
See the [native acceptance record](wordpress-native-acceptance.json) and
[current validation report](general-agent-validation.md) for exact package
provenance, the install's upload-directory warning, and final R12 check scope.

1. Select a model with native tool support; use **Measure speed & tool format**
   and optionally **Validate model for tasks**. A chat-only model cannot create
   project files or run commands. A simple validation pass does not establish
   WordPress or complete-project competence.
2. Choose **Agent**, then use sidebar **Add folder** for an existing empty
   workspace, or **Create folder** to name a new workspace and choose its parent
   folder. Start **New task** if you want to change an existing task's workspace.
3. In **Tools**, enable **Create & edit files** and **Terminal**. File
   reading and **Find files & text** let the model inspect its workspace and results.
4. Ask for the result you want, for example:

   > Create a local WordPress project in this empty workspace, including setup
   > files and a small custom theme. Inspect installed tools, create the project,
   > and run available validation. Report the exact steps still needed to start it.

5. Review the proposed files before **Approve once**. The agent can propose
   1–20 **new** text files in a single `create_files` batch, with a maximum of
   512 KiB of combined UTF-8 content. Parent folders are created automatically.
   The batch cannot overwrite an existing file; replacements and edits require
   a separate reviewed action. Larger scaffolds need multiple approved batches.
6. Review each setup, installation, or validation command before approving it.
   A project may need PHP, a database, Docker, WP-CLI, or other tools depending
   on the chosen setup. The agent can inspect what is installed; dependencies
   must already be present or be installed through approved commands. Downloads
   and package installation can require the internet.
7. Inspect the created files and the recorded check results. PHP and PHTML files
   are supported by local file reading and project search. A scaffold is a set
   of project files; a running WordPress site also needs its services started
   and a successful runtime check. File creation alone does not prove that the
   site is installed, healthy, or ready to publish.

**Undo** treats a new-file batch as a group, removing the unchanged files
it created and any newly created directories that remain empty. Files changed
outside the app are preserved. Undo cannot reverse package installations,
database changes, or other terminal-command side effects.

Agent mode is instructed to inspect versions and prerequisites, implement, run
appropriate checks, and repair observed failures through its tools and approvals.
This policy applies to general tasks, including an empty workspace. It respects
action denials, and an interrupted task never
automatically repeats an approved command or edit. If tools, an approval, a
dependency, or networking block completion, the result should identify that
observed blocker and the work already performed. The
[current validation record](alpha4-validation.md) separates passed checks,
retained historical failures, and the remaining profile checks. The
[earlier update record](agent-update-validation.md) retains its own payload scope.

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

Clone the [source repository](https://github.com/mahdizareeii/AiAgent) and run the
following preparation commands from its root:

```sh
git clone https://github.com/mahdizareeii/AiAgent.git
cd AiAgent
```

Dependency preparation uses the internet, and the Goose Rust build can take
substantial time and disk space.

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

Free Local Agent keeps the legacy `Local Agent` data-folder name so rebranding preserves
existing chats, cached models, project paths, and undo records. The normal
application-data locations are
`~/Library/Application Support/Local Agent`, `%APPDATA%/Local Agent`, or
`~/.config/Local Agent` (subject to XDG configuration). An explicit
`--user-data-dir` override starts a separate profile with independent chats and
models. Its **Separate test profile** banner and model setup show the app-data
and model-cache locations. Profiles are not automatically merged or copied; open
the app without an override to use the regular retained store. The folder contains chats, model
files, imported-model records, stage checkpoints, and edit snapshots. Speed and
tool-calibration results currently stay in memory for the runtime session and
are checked again after restarting it.
No disk encryption is added by the app. Avoid granting sensitive material you do
not intend the local model to read.

Approved commands run as your operating-system account and can access files or
networks beyond the project directory. There is **no OS command sandbox**. Read
and write tools enforce their own grants; those grants do not constrain an
approved shell command. Undo restores saved file snapshots and cannot reverse
terminal-command side effects. See [architecture and boundaries](architecture.md).

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

[Native CI](../.github/workflows/alpha.yml) prepares resources, requires integration
checks, packages the app, runs offline resource/MCP/approval smoke checks, and
uploads packages with SHA-256 checksums. It has read-only repository permissions
and does not publish a GitHub release. PyInstaller packaging runs natively on each OS.

Application code is [Apache-2.0](../LICENSE). Goose retains its upstream license and
notices. The bundled llama.cpp engine is MIT; its pinned license texts accompany
inference resources. Python dependency licenses accompany the research sidecar.
[NOTICE](../NOTICE) identifies principal dependencies. Model weights are separate
artifacts governed by their own published licenses.
