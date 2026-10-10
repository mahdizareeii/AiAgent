# Free Local Agent verification status

## Current 0.4.0-alpha.1 workspace/plugin update — 2026-10-10

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
