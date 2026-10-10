# Free Local Agent setup and developer guide

Free Local Agent **0.4.0-alpha.2** runs local models through a bundled llama.cpp engine. The
packaged app includes the native inference engine, offline Goose backend, and
research sidecar; model weights are downloaded or imported separately. Start
with the [project overview](../README.md) for features, screenshots, and current
platform support.

## First launch

On macOS Apple Silicon, unzip `Free Local Agent-0.4.0-alpha.2-arm64-mac.zip`, move `Free Local Agent.app` into
Applications, and open it; the runtime is included and model weights are downloaded
or imported separately.

1. Open **Models & hardware** and inspect the detected hardware and bundled runtime.
2. Choose a model that fits, then **Download model** and **Use model**. Alternatively,
   choose **Import GGUF**. Compatible GGUF architecture and chat-template metadata
   are required; unsupported files or variants can fail validation. An imported
   model starts in chat-only mode. Agent tools are enabled only after the runtime
   confirms native tool support and a local calibration passes.
3. Optionally **Check tools & speed**. This checks native tool calling and measures
   generation speed, not complete agent-task quality. Enable **Allow slow mode** only if you
   accept slower CPU/offload operation for a model classified as slow.
4. Start **New task**. New tasks default to **Agent** mode. Before starting,
   use **Add folder** in the sidebar to choose an existing workspace, or
   **Create folder** to name a new folder and choose its parent in the native
   picker. Enable the tools your task needs. File reading works
   in every mode; project search, file creation/editing, and terminal commands
   work in Agent independently of Research. Web tools work in Agent and Read-only
   research after you enable both Research and web access in **Plugins**. Use
   **Chat** for conversation and attached-file reading. A chat-only model can
   process attached files through local read stages, but cannot run Agent tasks.
5. Review proposed edits/commands and **Approve once** or **Deny**. **Stop** cancels
   the task. **Resume task** appears for a paused read-only checkpoint. An
   interrupted agent turn needs a new request; Resume does not replay its actions.

The neutral, Codex-inspired workspace has a task sidebar, a centered conversation,
and a bottom composer. The composer groups mode, workspace, tool, research, and
model controls with your message. **Plugins** and **Models & hardware** are in the
sidebar. Use the moon/sun toggle at the bottom of the sidebar to switch light/dark
themes; the preference is saved locally. **Read-only research** appears in the mode
selector when its plugin is enabled. Saved research tasks can still be opened
with the plugin disabled, without reactivating it.

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

Thinking appears only when the model emits it. The panel says when thinking
text has not been provided; the app does not construct a reasoning transcript.
Thinking is separate from the answer, bounded to 64 KiB per reply, and stored
locally with the conversation. It can be expanded after completion and restored
when the task is reopened, including partial thinking captured before a stop or
error. Tool activity and stage details are current-run information and are not
restored from saved conversation history. See the
[0.4.0-alpha.2 Working and folder validation record](working-folders-validation.md).
This update and its package are kept local and have not been pushed or published
as a GitHub release.

## Optional Research plugin

The **Plugins** page contains **Research**, an optional bundled workflow backed
by the [task-research skill](../local-agent/desktop/skills/task-research/SKILL.md).
When enabled, it guides Agent and Read-only research tasks to inspect project
versions, resolve changing setup/API requirements, and use the findings while
completing the task. It needs no hosted model account or separate installation.
There is no arbitrary external plugin installer in this version.

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
the next turn. File reading, project search, file editing, and terminal controls
remain in **Tools** and work independently. Plugin and web preferences persist
separately; disabling Research retains the saved web permission for your next
explicit enable. Changes are unavailable while a task is running. Legacy version
1/2 settings with explicit web research consent migrate with Research enabled;
version 3 settings missing a plugin toggle default off. Chats, attachments,
selected models, workspaces, and undo records are preserved. See the
[previous 0.4.0-alpha.1 workspace and plugin validation record](workspace-plugin-validation.md).

## Creating a WordPress project

Use Agent mode for work that creates files or executes commands. An older saved
Chat conversation remains read-only; start **New task** in Agent mode to build a project.
An earlier Qwen4B test created approved files, but its complete WordPress setup
failed validation and did not start a site. A separate two-file theme task passed
file creation, readback, and static checks, but no PHP or WordPress runtime ran.
Review generated configuration and reported checks rather than treating file
creation as successful installation.

1. Select a model that has passed **Check tools & speed**. A chat-only model
   cannot create project files or run commands.
2. Choose **Agent**, then use sidebar **Add folder** for an existing empty
   workspace, or **Create folder** to name a new workspace and choose its parent
   folder. Start **New task** if you want to change an existing task's workspace.
3. In **Tools**, enable **Create & edit files** and **Terminal**. File
   reading and project search let the model inspect its workspace and results.
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

Agent mode is instructed to inspect, implement, and validate rather than stop
after a plan. It respects action denials, and an interrupted task never
automatically repeats an approved command or edit. If tools, an approval, a
dependency, or networking block completion, the result should identify that
observed blocker and the work already performed. The
[update validation record](agent-update-validation.md) separates tested behavior
from checks that are still pending.

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
`--user-data-dir` override is also supported. The folder contains chats, model
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
