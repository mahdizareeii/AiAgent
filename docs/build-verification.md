# Free Local Agent verification status

## Current 0.4.0-alpha.3 general-agent update — 2026-10-11

The native WordPress example **passed 12/12 independent checks** on the
preceding R11 package after guided separate app tasks and normal approvals.
Installed WP7.1.3, healthy DB, intended title, homepage HTTP200, actual login
form HTTP200, and official image digests were verified without observer setup
mutations. A later native R12 task repaired uploads permissions and created the
verified handoff; read-only checks confirmed writable permissions as the web
user. Browser media upload was not tested. Final R12 native Chat/file/control
checks remain pending. Exact scope
and provenance are in the [native acceptance record](wordpress-native-acceptance.json).

The latest recorded alpha.3 revision passed strict TypeScript and **210/210
app/runtime tests**, with no failures, skips, or cancellations, public
networking denied, and loopback allowed. The run took **38060.4675 ms**.
This includes **10 renderer-flow helper tests**. Its rebuilt macOS package
passed offline native smoke. The ZIP is **216,988,256 bytes**, SHA-256
`8dd30c4b8a201b7253d671240fb434cfcf1b8cce4ac1eaf150021ebdd1a56ff0`;
the ASAR SHA-256 is
`cd7c1a487cb3d9b03236e1b364731e47c54a4e7def4e12a4b96913dfb67d60df`.
The [package record](general-agent-package.json) identifies this artifact,
including retained Working tool history, standalone macOS workspace directory
panels, cancellation during model
verification, and actionable missing-log recovery. It is stored in
`release/general-agent-delivery/`. It was built from local production-source
commit `9274901`; its native folder-to-task acceptance is recorded separately.
Its Goose executable SHA-256 is
`3f4cbe2770ebf24a11248f82fa825f0ed969ab9d74912f8f6104dc067d840055`.
The offline build pins bundled ACP tool initialization to MCP `2025-11-25`.
A real nine-second delayed-tool-start regression passed, and packaged smoke
started the actual Goose ACP tool extensions against a metadata-only local
endpoint without sending a prompt or executing an action.

Read-only compaction now derives its summary allowance from native-counted
remaining capacity after the full protected request, rather than a fixed
percentage of context. Protected instructions/current/pending/command/edit
exchanges stay exact; summarization never executes or replays actions. Two
new capacity tests passed in the current 210-test suite.

The latest command result includes a durable UUID, an exact unique `log-xxxxxxxx`
handle when available, and explicit completeness/paging metadata. Unknown,
ambiguous, malformed, traversal, and other-chat references remain rejected;
output reads never execute commands. Three additional regression tests passed
within the current suite.

The preceding R10 app added **File → Save screenshot…**. A native export saved
the actual app viewport as PNG through its enabled Save dialog. Native
spellcheck and automatic text-field correction/capitalization are disabled as
an input-latency mitigation; the observed spell-server timeout does not prove
the cause of earlier stale automation or screenshots.

During an actual R10 model turn, Working stayed expanded while file reads and
an approved configuration check updated; tool inputs/results toggled visibly.
The command ran once and failed on the generated healthcheck’s invalid format.
A matched native screenshot records that validation/repair stage before
WordPress was installed.

The preceding R11 app then completed one approved healthcheck edit correctly in
a bounded guided task. Its saved exchange retained two completed tools and
684 thinking bytes. The next native task validated Compose and started
services once through normal approvals; independent read-only inspection found
the DB healthy and WordPress running on loopback8096. Four completed tools and
1,011 thinking bytes persisted. Core installation and HTTP/login acceptance
were not yet established at that stage; the later native install and 12-check
validation passed.

The preceding renderer passed **14 separate synthetic Electron scenario groups** for
first-model setup, stale-status protection, profile identity, Research
controls, retained-model startup, expanded Working, scrolling, model/preflight
recovery, queued-approval cancellation, and first-chunk disclosure transition.
The command-log and folder-picker fixes through R7 left those tested renderer
assets unchanged. R8 then changed the renderer to retain tool history; these
14 scenario groups have not been rerun for the current renderer; R10 also
changes text-field spellcheck attributes. Six new durable-history tests
passed as part of the current 210-test suite.

The preceding package passed real local chat and approved file
create/edit/readback with public networking denied. A following revision, before
the folder-picker correction, returned exactly `42` in a component check, but
that run's subsequent file task was
interrupted at an unresolved approval and its report was not finalized. These
component checks do not establish the visible workflow. Initial native
empty-profile onboarding and task-workspace screenshots are retained. The preceding R7
package also created and selected a new workspace through its native parent
picker. During a real Qwen task, mouse, Space, and Enter toggled Working, its
expansion persisted across streamed thinking and tool updates, and an approved
Docker version command completed. A fully installed WordPress site was not
yet verified by that R7 prerequisite stage.
The preceding R9 app subsequently completed one guided approved Compose
correction and verified it with a file read. Its saved exchange retained
2,180 thinking bytes and five named tool activities with inputs/results.
That R9 correction did not establish service startup or WordPress installation.
See the [general-agent validation record](general-agent-validation.md) for the
current acceptance matrix and provenance. Six incomplete WordPress attempts
include image download and inspection, denied unsupported commands/edits, and
one completed healthcheck edit followed by repeated missing-log reads. Denied
actions did not execute or replay. Changes remain local.

## Earlier 0.4.0-alpha.2 Working/folder update — 2026-10-10

Expandable model thinking and explicit workspace creation passed **141/141**
app/runtime tests with public networking denied, **12/12** separate renderer
scenario groups, a real Qwen3.5 4B thought/answer separation check, and the final
macOS packaged smoke. A fresh native workspace screenshot is now available;
visible thinking-keyboard activation and the complete native folder workflow
remain pending. See the [Working/folder record](working-folders-validation.md)
for exact limits, measurements, and artifact checksum. Delivery remains local.

## Earlier 0.4.0-alpha.1 workspace/plugin update — 2026-10-10

The focused task workspace and optional Research plugin passed **123/123**
app/runtime tests with public networking denied, **10/10** additional isolated
renderer checks, and the macOS arm64 packaged smoke. The new ZIP is built and
verified. Fresh native screenshots remain blocked by desktop inspection timeouts;
the older model image is historical. See the
[workspace and plugin validation record](workspace-plugin-validation.md) for
permissions, migration, artifact checksum, and exact test limitations.

## Earlier 0.3.0-alpha.2 research update — 2026-10-10

The bundled task-research skill, opt-in Agent web tools, provenance metadata,
offline behavior, and current validation are recorded in the
[research validation report](task-research-validation.md). The prior theme,
project-file, and upgrade evidence remains below with its original version.

## Earlier 0.3.0-alpha.1 update — 2026-10-10

The 0.3 update adds the Agent/Research/Chat workflow, workspace creation,
reviewed new-file batches with grouped undo, PHP/PHTML reading/search, and the
saved light/dark theme. The macOS package and packaged smoke passed. The real
Qwen4B complex task demonstrated approved file creation, but its complete
WordPress scaffold failed validation. A separate two-file theme creation/readback
task passed static checks. One initial model-setup screenshot is retained as
partial evidence; full visible GUI validation remains pending after capture-tool failure.

| Check | Recorded result |
| --- | --- |
| Strict TypeScript and full JavaScript/TypeScript suite (`npm run check`) | 106/106 passed; no skips; public network denied and localhost allowed |
| Research tests | 61/61 passed |
| Rebuilt frozen research sidecar | 5/5 protocol checks passed |
| Separate temporary renderer regressions | 8/8 passed; separate from the 106-test suite |
| macOS arm64 package | Built as `Free Local Agent-0.3.0-alpha.1-arm64-mac.zip` |
| Final 0.3 packaged smoke | Passed with public network denied and localhost allowed; native pins/MCP verified, denied write unchanged, web tools absent by default |
| Final 0.3 archive size/SHA-256 | 217,016,826 bytes; verified SHA-256 recorded below |
| Real Qwen3.5 4B complex WordPress task | Action routing passed: five approved file creations and zero approved commands; complete scaffold failed independent validation; no site launched |
| Separate two-file minimal-theme task | Passed in one attempt: one `create_files` approval, two files created, two readbacks with matching SHA-256 and passing static checks; no PHP/WordPress execution |
| Initial 0.3 model-setup screenshot | Captured; real M5 / 24 GB RAM, with 3.8 GB available during a separate model run; partial GUI evidence only |
| Full visible GUI and further screenshots | Pending; capture tool returns stale frames / ScreenCaptureKit error -3811 despite the desktop being unlocked |
| Normal-config upgrade preservation | Passed: three saved chats and message counts, selected model and utilities retained; cached GGUF size/mtime unchanged |
| GitHub publication | Pending authentication; no push completed; current installer and source changes are local |
| Windows/Linux native execution | Pending; packaging/CI configuration alone is not native validation |

The 106-test suite ran under macOS `sandbox-exec` with public outbound networking
denied and only localhost permitted. This is a test restriction, not an OS
command sandbox in the shipped application. The separate renderer cases do not
replace a visible GUI or real-model task check. Creating a WordPress scaffold
is distinct from installing and starting its services.

The final packaged smoke loaded the packaged Electron/ASAR action bridge and
confirmed a denied write left project content unchanged. It verified the
Goose/inference pins and frozen sidecar MCP tools, with web tools absent by
default. This test does not replace visible GUI validation.

The normal updated app opened against the retained legacy data store, without
diagnostic GPU/background flags. A content-free upgrade check confirmed three
saved chat identities and message counts, selected model, and utility preferences
were preserved. The cached **2,740,937,888-byte GGUF** retained its size and
modification time; it was not downloaded again. Private chat IDs, contents, and
local data paths are not included in this report. This preservation check does
not establish a completed interactive GUI or new packaged model run.

Only the [initial model-setup screenshot](screenshots/free-local-agent-models.png)
is retained. It came from an isolated validation profile and contains no user
chat data. It shows the actual 0.3 app's M5 / 24 GB hardware assessment and a
3.8 GB available-memory snapshot during an independent model run. Later UI
controls updated, but screen pixels remained stale and clicks could not obtain
a new frame. The user confirmed the Mac was unlocked. The last native capture
error was `ScreenCaptureKit SCStreamErrorDomain -3811`, an audio/video capture
failure. Temporary `--disable-gpu` and background-flag diagnostics did not
restore capture; no production GPU configuration was changed. Home, chat, and
tool screenshots are omitted rather than presented as completed captures.
Publishing the current changes to GitHub remains pending authentication; no
push completed. The capture error does not establish a graphics root cause.

The native Qwen4B complex-project run used Metal, 8192 context, 2048 reserved
output, 512 batch, and 128 microbatch tokens. Local calibration measured
**24.97 tokens/sec** on the 24 GiB Apple M5 with **7.10 GiB available memory**.
The model created five real files through approved actions with no truncated
tool arguments. It did not complete the requested WordPress scaffold: the PHP
bind source incorrectly named a directory, and generated PHP configurations
missed the WordPress bootstrap and duplicated definitions. Protected `.env`
file attempts were blocked.

The gateway stopped the current inference request when **6321 input + 2048
reserved output** exceeded the **8128-token usable budget**. Active action
history was preserved, and completed actions were not replayed. The agent ran
no approved terminal command; no container or site was launched. See the
[native complex-task record](wordpress-agent-smoke.json) and the
[update validation record](agent-update-validation.md). This is a successful
action-routing check and a failed full-project check, not a coding-quality
benchmark or a running-site claim.

The separate minimal-theme task used the same pinned Qwen4B model and Metal
8K/2048-output profile. One approved `create_files` batch created `style.css`
(509 bytes) and `index.php` (644 bytes). Both files were read back through the
real file tool; their SHA-256 values and sizes matched the created files.
Static checks found a Theme Name header, the WordPress loop, and expected hooks.
Native calibration measured **38.61 tokens/sec** in this separate run.

The task ran once with public networking denied. An initial harness assertion
incorrectly required absolute read inputs; the model used legal workspace-relative
paths. Correcting that harness assumption verified the existing owned result
paths, sizes, and hashes. The model was not rerun and its files were not manually
fixed. See the [minimal-theme record](wordpress-theme-agent-smoke.json).
No PHP syntax, WordPress execution, or browser rendering was checked. The output
uses core header/footer compatibility fallback and lacks a comprehensive escaping
audit; it is a small static task pass, not a production-theme or running-site claim.

Current archive: `Free Local Agent-0.3.0-alpha.1-arm64-mac.zip`,
**217,016,826 bytes**, SHA-256
`1c7bcd949570fb05b451201daa37f504b2a97b4ab3dfd2122eff60ac3dc2d3e7`.

See the [0.3 update validation record](agent-update-validation.md) for the task
scope and evidence still to record. Historical 0.2 checks and measurements are
preserved below; neither their archive checksum nor their model timings describe
the new package.

## Historical 0.2.0-alpha.1 evidence — 2026-10-07

This section preserves the earlier report, including its then-pending visible
GUI checks. References to the final package here concern the **0.2 archive**.

This report concerns **0.2.0-alpha.1**, which replaces the earlier Ollama alpha
with bundled inference and adds hardware fit, GGUF import/calibration, utility
controls, token-budget handling, and read-only stage checkpoints.

The current **Free Local Agent** package was rebuilt on macOS arm64 on
2026-10-07. Its full 81-test suite and packaged smoke passed again with public
networking denied and localhost allowed. The tests include tensor validation,
RAM-only CPU fallback, cancellation checks before mutation, and owned
command-process cleanup. Earlier **Local Agent** GUI measurements are identified
separately below; they do not establish visible GUI validation of the rebranded
package.

| Check | Current result |
| --- | --- |
| Strict TypeScript and desktop production build | Passed |
| Full JavaScript/TypeScript suite: runtime, downloads, hardware/GGUF, token budgets, checkpoints, permissions, undo, cancellation | 81/81 passed again after the final rebrand with public network denied and loopback allowed |
| Source-built offline Goose with deterministic local provider | All six integration cases passed; included in the full suite |
| Separate temporary hidden-renderer regressions | 4/4 passed for transient stage cleanup, busy-state ownership, and persisted transcript behavior; separate from the 81-test suite |
| Research tests | 59/59 passed in the earlier research rerun |
| Frozen-sidecar protocol tests | 5/5 passed in the earlier sidecar rerun |
| Final Free Local Agent packaged manifests, native version, and MCP/approval smoke | Passed with public network denied and loopback allowed |
| Final Free Local Agent visible GUI, fresh screenshots, and real-chat revalidation | Pending; the desktop is locked |
| Earlier Local Agent macOS arm64 first launch | Packaged app visually inspected; hardware/runtime ready and web research off |
| Earlier Local Agent import → chat-only model → Start a conversation → native chat | Passed using the 260K toy GGUF fixture; no catalogue-model quality claim |
| Earlier Local Agent packaged Qwen4B import, Slow mode, calibration, and Goose chat | Passed in the normal profile; 30.8 tokens/sec measured; returned exactly `LOCAL_APP_READY`; web research off |
| Windows x64 ZIP and Ubuntu x64 DEB | Native CI configured; not executed locally |
| Pinned Qwen3.5 4B native chat, tool calibration, token counting, and actual Goose/MCP file read | Passed with public network denied; SHA-256 verified; Metal 8K context / 512 batch / 128 microbatch; 37.48 tokens/sec calibration |
| Broad catalogue-model task quality, representative latency, and peak memory | Fifteen-task rubric not run; peak RSS and long-context behavior not measured |
| Final current ZIP checksum | `1d3885a5d8115ce193b9c5ecab9cae4ca86125e5849ef5f6bf26eb074ca91e4d` |

The final macOS archive is `Free Local Agent-0.2.0-alpha.1-arm64-mac.zip`,
**217,004,696 bytes**. Its native package smoke passed after the final rebuild.
The four temporary renderer cases are additional focused checks, not additions
to the checked-in suite count or a replacement for a visible GUI run.

The network-denied checks ran under an actual macOS `sandbox-exec` profile that
denied public outbound access and allowed only localhost communication. A separate
HTTPS request to `example.com` was confirmed blocked. The native processes, MCP
smoke, and automated checks ran under that restriction.

The earlier full Electron GUI could not start inside that additional macOS
sandbox: Chromium sandbox initialization failed. Earlier GUI inspection instead
used the normal Local Agent app with Electron renderer sandboxing, context
isolation, Node integration off, and the renderer's connection-blocking CSP. The
external public-network denial proof applies to the native/MCP/test checks, not
to those GUI runs. This test profile is not an OS command sandbox in the shipped
app. Fresh visible GUI checks of Free Local Agent are still pending desktop access.

The new package smoke verifies the offline Goose feature/hash manifest, the
bundled inference pin and complete file inventory, native engine version/flags,
packaged Electron/ASAR action bridge, a denied edit with unchanged file content,
`inspect_file` and verified file reading, and web tools absent by default. It lists
web tools only in an explicitly opted-in sidecar and calls no public network tool.
No model is loaded/downloaded by that smoke test.

The earlier Local Agent packaged UI exercise used an isolated profile and a
checksum-verified 260K toy GGUF with a simple chat template. Import was shown as
chat-only, the conversation started, and the request “Once upon a time” produced
a native local reply. This verifies the connected UI/import/chat path, not useful assistant
quality, representative latency, or 4B+ memory behavior. See
[native inference validation](native-inference-validation.md) for the fixture,
hashes, token counts, effective context, and Metal/CPU observations.

The separate real Qwen3.5 4B smoke verified the pinned 2,740,937,888-byte artifact,
its SHA-256, and all 426 tensor descriptors/payload bounds. Native chat returned
`LOCAL_MODEL_OK`, native token counts matched generation usage, and a function
schema produced the expected tool-call arguments. Loading plus local tool
calibration took 2.20 seconds in one short run with weights already local. The
calibration measured 37.48 tokens/sec on the Apple M5 Metal profile with 8192
context, 1024 reserved output, 512 batch, and 128 microbatch tokens.

The same loaded model, app gateway, bundled Goose ACP agent, and frozen research
MCP then read a fresh local fixture containing a random UUID and reproduced that
exact value. The entire native/Goose run denied public network access and allowed
only loopback. This is a completed real-model integration smoke, not a broad
coding benchmark or measured peak-memory claim. Measurements are retained in
[the Qwen smoke record](qwen4-native-smoke.json), with details in
[native inference validation](native-inference-validation.md).

The earlier Local Agent packaged app was exercised in its normal user profile
with the real Qwen4B file. It copied the local artifact into its cache and verified
its checksum. With only 4.7 GiB available memory, setup required explicit Slow
mode before calibration. Calibration passed and the UI displayed **30.8
tokens/sec**, **Metal / 8192-token context**, and calibrated agent tools. Starting
a conversation and asking “Reply exactly: LOCAL_APP_READY” returned exactly
`LOCAL_APP_READY` through the packaged desktop and Goose, then displayed task
completion. Web research remained off. The earlier toy chats stayed in their
separate isolated profile.

This earlier GUI observation is a distinct run from the 37.48 tokens/sec native
smoke and is not a measurement of the final Free Local Agent package. It used
normal Electron renderer sandboxing and context isolation, with the
additional macOS public-network-denial limitation described above; it does not
establish a GUI-wide external network-denial test or a performance distribution.

Native inference packaging uses pinned official llama.cpp binary archives and
preserved notices. Goose is source-built with online model metadata excluded;
using an old default-feature Goose binary must fail the manifest check. Signing
that changes packaged binary bytes must be handled by the verified packaging
process, not by disabling manifest validation.

The macOS alpha is unsigned and not notarized. Windows/Linux native jobs are
configured for their own runners but have not been run locally. Broader
model-specific task quality, long-context memory behavior, and large-document tasks need
[the manual validation plan](alpha-validation.md), even after protocol tests pass.
