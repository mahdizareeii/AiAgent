# Free Local Agent compatibility report

## Current 0.4.0-alpha.3 general-agent update — 2026-10-11

A guided native R11 WordPress setup passed **12 independent acceptance
checks** with Qwen3.5 4B: installed core, healthy DB, intended title, loopback
homepage HTTP200, real loginform HTTP200, and official ARM64 image digests.
It required bounded separate requests and corrections. This proves the tested
workflow with supervision, not one-prompt autonomy. The initial install
warned about upload-directory permissions. A later native R12 task repaired
them and created the handoff; independent read-only checks confirmed writable
permissions as the web user. Browser media upload was not tested. Final R12
native Chat/file/control checks remain pending. The
[sanitized native record](wordpress-native-acceptance.json) preserves exact
package provenance and read-only verification scope.

On this Apple M5 / 24 GiB macOS arm64 machine, the latest recorded alpha.3
revision passed **210/210 app/runtime tests**, including **10 renderer-flow
helper tests**, with no failures, skips, or cancellations, public networking
denied, and loopback allowed. The run took **38060.4675 ms**. Its rebuilt macOS
package passed offline native smoke. The ZIP is **216,988,256 bytes**, SHA-256
`8dd30c4b8a201b7253d671240fb434cfcf1b8cce4ac1eaf150021ebdd1a56ff0`;
the [package record](general-agent-package.json) records the matching ASAR hash.
This artifact includes retained Working tool history, standalone macOS workspace
directory panels, cancellation during
model verification, and actionable missing-command-log guidance. The latest
Goose build also pins ACP tool initialization to MCP `2025-11-25`, repairing
the cold-start protocol retry observed before actions in R8. A real delayed
startup regression and actual packaged ACP tool startup passed without
model inference.

R10 added real app viewport PNG export through **File → Save screenshot…** and a
native Save dialog; an actual export passed. It disables native spellcheck and
automatic correction/capitalization as an input-latency mitigation. Observed
spell-server timeouts do not establish the cause of previous automation/capture
failures.

The preceding R10 native turn showed streamed thinking and named tool activity,
retained Working expansion across updates, and visibly toggled tool inputs/results.
An approved configuration check executed once and reported invalid generated
healthcheck syntax. Its genuine screenshot records validation/repair in progress
before the later R11 service startup and installation.

R12 budgets read-only summaries against the complete native-counted request’s
remaining capacity, retaining protected exchanges exactly. Two new capacity
regressions passed; the current native task acceptance remains pending.

R11 makes command results explicit about saved log identity, whether all output
is shown, and the next byte offset. Returned short handles resolve only an
exact unique log in the current chat; rejection and no-replay protections
remain in force. Three new regression tests cover this generic output path.
The preceding R11 app then completed a correct approved healthcheck edit, with
two completed tools and 684 thinking bytes saved. A following native task
validated Compose and started the cached services once; independent inspection
found the DB healthy and WordPress running on loopback8096. Core installation
and HTTP/login acceptance were not yet established at that stage; the later
native install and 12-check validation passed.

The preceding renderer passed **14 separate synthetic scenario groups**. The
R8 renderer change retains tool history; those groups have not been rerun for
the current renderer, which also changes spelling attributes in R10. Six
new durable-history tests passed within the current 210-test suite. Native
empty-profile onboarding and workspace captures are retained. The preceding R7
package completed native folder creation and selected the new workspace.
An R7 Qwen task visibly expanded Working using mouse, Space, and Enter,
retained expansion across streaming/tool updates, and completed an approved
Docker version command. That R7 prerequisite stage did not establish an
installed site; desktop capture and interaction have been intermittent.

The preceding package's real component Chat and approved file
create/edit/readback passed with public networking denied. Its short calibration
measured **37.902 tokens/sec**. Earlier component samples of **30.393** and
**32.9375 tokens/sec** retain their original package provenance. The
preceding missing-log-fix package returned exactly `42` and calibrated at
**38.023 tokens/sec** before
its next file task was interrupted at an unresolved approval. That run was not
finalized and does not establish a passing file or WordPress task. All samples
used Metal / 8K context / batch 256 / microbatch 64. Each is one short
calibration, not a latency distribution or peak-memory benchmark.

On 2026-10-11 the preceding missing-log-fix build selected an existing test
workspace through the native picker and displayed a short **28.7 tokens/sec**
calibration. The preceding file-filter-reset build retained its folder/model selection
but requested recalibration. These are partial native observations, with no
completed Agent turn, expanded Working, or new task screenshot.

The preceding R8 app subsequently measured a short **7.7 tokens/sec** calibration
with Metal, an **8192-token** context, and Slow mode enabled. The hardware
refresh reported approximately **4.1 GB available memory** on this 24 GiB
machine. This is one sample under active memory pressure, not a sustained task
speed or a comparative benchmark. A native repair/install request was submitted
at that stage; calibration did not establish its completion.

The preceding R9 app completed a guided approved file correction and, after
reopening the saved task, visibly expanded Thinking to show its five named tool
records. Its new short calibration measured **12.1 tokens/sec** with Metal,
8192-token context, Slow mode, and approximately 4.1 GB available memory. This
remains a single calibration under active memory pressure, not task throughput.
That R9 correction did not establish service startup or WordPress installation.

Six incomplete WordPress component attempts are recorded. A continuation
downloaded all three images, but unsupported edits and an incorrect inspection
command were denied before execution. A later approved healthcheck edit was
preserved, followed by repeated reads of a missing command log and cancellation.
The tested 4B model needs smaller guided steps and independent validation; those
component attempts did not establish an installed site. Windows/Linux native execution remains
pending. See the [general-agent validation record](general-agent-validation.md)
for current scope and gaps; earlier measurements below retain their versions.

## Earlier 0.4.0-alpha.2 Working/folder update — 2026-10-10

The macOS arm64 update passed **141 app/runtime tests**, **12 separate renderer
scenario groups**, and the final offline packaged smoke. A native Qwen3.5 4B run
verified separate model thoughts and final output with the bounded reasoning
profile. A short calibration measured **36.80 tokens/sec** on M5/24 GiB using
Slow Metal, 8K context, batch 256, and microbatch 64; this is not representative
task latency or peak memory. Fresh native workspace capture succeeded. See the
[Working/folder record](working-folders-validation.md) for measured scope and
remaining native UI/Windows/Linux checks.

## Earlier 0.4.0-alpha.1 workspace/plugin update — 2026-10-10

The update retains the existing inference engine and hardware profiles. The
macOS arm64 package, **123 app/runtime tests**, **10 separate renderer checks**,
and packaged offline smoke passed. No new model-speed or task-quality benchmark
was run. Native screenshots are blocked by desktop inspection timeouts, and
Windows/Linux native execution remains pending. See the
[workspace and plugin record](workspace-plugin-validation.md) for artifact
details and the distinction between protocol, renderer, and visible GUI evidence.

## Earlier 0.3.0-alpha.2 research update — 2026-10-10

The research update uses the existing bundled inference and hardware profiles.
One native Qwen4B research-to-file task ran on the Apple M5 with an 8K context,
2048 output reserve, and explicit Slow mode under current memory pressure.
Its short calibration measured **22.76 tokens/sec**; this is not packaged GUI
latency, peak memory, or broad task-quality evidence. See the
[research validation report](task-research-validation.md) for test results,
artifact details, and model-output limitations. Windows/Linux native execution
and further interactive GUI validation remain pending.

## Earlier 0.3.0-alpha.1 update — 2026-10-10

The macOS arm64 0.3 package is built. Its final automated suite passed
**106/106 JavaScript/TypeScript tests with no skips**, with public networking
denied and localhost allowed. Research tests passed **61/61**, the rebuilt
frozen sidecar passed **5/5** protocol checks, and **8/8** separate temporary
renderer regressions passed. The renderer cases are not part of the 106 count.

| Target or measurement | Current 0.3 evidence | Pending validation |
| --- | --- | --- |
| macOS arm64, minimum macOS 13.3 | Native package built; automated suite/package smoke passed; archive verified; initial setup screenshot and normal-config data preservation checked | Full interactive GUI and further screenshots; capture tool failed |
| Qwen3.5 4B complex WordPress task | Action routing passed with five approved file creations; complete scaffold failed independent validation; no approved agent commands or site launched | Broader task quality and complete-project validation |
| Qwen3.5 4B two-file theme task | One approved batch created both files; real readback hashes and static structure checks passed in one attempt | PHP/WordPress execution, rendering, and production theme quality |
| Current 0.3 speed | Separate native calibrations measured 24.97 and 38.61 tokens/sec on M5, 24 GiB RAM, Metal 8K context / 2048 reserved output / 512 batch / 128 microbatch | Representative latency, peak memory, and broader model/context benchmarks |
| Windows x64 / Ubuntu x64 | Native packaging/CI remains configured | Execute native packages and model checks on their target platforms |

Earlier macOS artifact: `Free Local Agent-0.3.0-alpha.1-arm64-mac.zip`,
**217,016,826 bytes**, SHA-256
`1c7bcd949570fb05b451201daa37f504b2a97b4ab3dfd2122eff60ac3dc2d3e7`.
Both native task results are recorded. The initial model-setup screenshot is
partial evidence; full visible GUI checks and further screenshots remain pending.
Earlier 0.2 generation-speed results below are
historical rather than measurements of the 0.3 package. A WordPress
scaffold does not establish an installed or running site, and tool access does
not establish Codex-equivalent task performance.

The [actual initial 0.3 setup screen](screenshots/free-local-agent-models.png)
shows Apple M5, 24 GB system memory, and 3.8 GB available during a separate native
model run. It was captured from an isolated validation profile with no user chat
data. Available memory is a momentary snapshot. It does not establish a
complete GUI workflow. The Mac was confirmed unlocked, but later captures
returned stale pixels and `ScreenCaptureKit SCStreamErrorDomain -3811`
(audio/video capture failure). Diagnostic GPU/background launch flags did not
restore capture and were not added to production configuration. The capture
error alone does not establish a graphics root cause.

The updated app opened with normal configuration and the existing legacy store.
A content-free check confirmed three saved chat identities/message counts,
selected model, and utility preferences remained intact. The cached
2,740,937,888-byte GGUF had unchanged size/modification time and was not downloaded
again. Private chats and paths are omitted. This check is limited to data
preservation, not complete interactive GUI or packaged inference validation.
GitHub publication of these changes is pending authentication; no push completed.

The Qwen4B run began with **7.10 GiB available memory** and used the pinned
artifact SHA-256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
Its five approved file creations had no truncated arguments, but independent
WordPress validation failed: a PHP bind source named a directory, and generated
PHP configuration lacked the bootstrap and duplicated definitions. Protected
`.env` attempts were rejected. The gateway stopped when 6321 input tokens plus
2048 reserved output exceeded its 8128-token usable budget, without compacting
active action history or replaying completed actions. No container or site was
started. The **24.97 tokens/sec** figure is one short native calibration, not
packaged GUI latency, peak memory, or evidence that the full task passed.
See the [complex-task record](wordpress-agent-smoke.json).

The separate minimal-theme task passed in **one attempt**. One `create_files`
approval produced `style.css` (**509 bytes**) and `index.php` (**644 bytes**),
and two real readbacks matched their SHA-256 values and sizes. Static Theme Name,
WordPress-loop, and hook checks passed. Its native calibration measured
**38.61 tokens/sec**, with **7.34 GiB available RAM** at the hardware snapshot.
The initial harness expected absolute read inputs; accepting the legal
workspace-relative paths verified the existing results without rerunning the
model or modifying its files. See the [theme-task record](wordpress-theme-agent-smoke.json).

No PHP syntax, WordPress execution, or rendered-site check ran. The two-file
output relies on core header/footer compatibility fallback and has no
comprehensive escaping audit. Static success is limited to this small task and
does not turn the failed complex scaffold into a passing full project.

See [current build verification](build-verification.md) and the
[0.3 update validation record](agent-update-validation.md).

## Historical 0.2.0-alpha.1 evidence — 2026-10-07

The earlier hardware snapshots, archive metadata, and model runs are preserved
below. Pending checks in this section reflect the earlier report, not a result
for the 0.3 package.

This report separates observed setup and native checks from model estimates and
uncompleted task benchmarks. It covers **0.2.0-alpha.1**, including the current
Free Local Agent package and explicitly identified earlier Local Agent GUI runs.
See [build verification](build-verification.md) for current automated checks and
[the real-model rubric](alpha-validation.md) for the fifteen-task quality run.

### Development hardware observed

The earlier Local Agent packaged macOS first-launch screen was inspected on this
development machine. Available memory and free storage are snapshots and change
with other programs. Fresh visible GUI checks of the final Free Local Agent
package are pending because the desktop is locked.

| Field | Observed value |
| --- | --- |
| Platform / architecture | macOS / arm64 |
| CPU | Apple M5, 10 CPU cores |
| System memory | 24 GB as displayed |
| Available memory at inspection | 7.4 GB as displayed |
| Free storage at inspection | Approximately 500 GB as displayed |
| Inference engine | Bundled llama.cpp 0.6.0, build 11429 |
| First-launch defaults | Web research off; no model weights bundled |

Native Metal and CPU sanity checks passed using a 260K toy GGUF fixture. Its
effective context was 2048 tokens, and native token counting/generation reported
8 prompt tokens and 16 completion tokens for the short native-engine test. The
earlier Local Agent package also passed an isolated-profile import → chat-only
selection → Start a conversation → local chat exercise using “Once upon a time”. These
checks establish native loading and the connected UI/inference path, not useful
assistant quality or catalogue-model speed/memory. See
[native inference validation](native-inference-validation.md) for fixture hashes
and the separate Metal/CPU observations.

The final Free Local Agent build passed 81/81 JavaScript/TypeScript tests again
and its macOS packaged MCP/resource smoke after rebuilding. Both ran with public
outbound access denied by macOS `sandbox-exec`, permitting only localhost; an
external HTTPS request was confirmed blocked. Four separate temporary
hidden-renderer regressions also passed for transient stage cleanup, busy-state
ownership, and persisted transcripts; these are not included in the 81 count.
Earlier research and frozen-sidecar reruns passed 59/59 and 5/5 respectively.

The earlier full GUI could not initialize inside the additional macOS sandbox.
Its visual check used normal Electron renderer sandboxing and context isolation,
so the external denial proof covers native/MCP/tests rather than the GUI itself.
The final suite includes tensor validation, RAM-only CPU fallback,
cancellation-before-mutation, and owned command-process cleanup checks. A hidden
renderer check does not replace the pending visible GUI and fresh real-chat run.

The final macOS ZIP is `Free Local Agent-0.2.0-alpha.1-arm64-mac.zip`, **217,004,696
bytes**, SHA-256
`1d3885a5d8115ce193b9c5ecab9cae4ca86125e5849ef5f6bf26eb074ca91e4d`.

### Estimated model fit versus measured results

The catalogue's working-memory numbers include estimated context/scratch space.
Fit also reserves memory for the operating system. Neither the estimate nor a
fit label measures actual peak memory. Four-bit weights reduce memory/storage
with a precision tradeoff; staged reading reduces context, not model weights.
The card's expanded estimate separates weights, 8K context, scratch, OS reserve,
system budget, and GPU budget. The loaded runtime profile can report a smaller
context after fallback. Unified GPU memory is shared with system RAM.

| Model | Catalogue working-memory estimate | Calibration / real-model result |
| --- | --- | --- |
| Qwen3.5 4B Q4_K_M | 4.5 GiB | Native chat/tools/Goose file read passed; 37.48 tokens/sec native and 30.8 tokens/sec earlier Local Agent calibration; final visible chat pending |
| Qwen3.5 9B Q4_K_M | 8 GiB | Not run |
| Gemma 4 12B QAT Q4_0 | 10 GiB | Not run |
| Gemma 4 26B A4B QAT Q4_0 | 19 GiB | Not run |
| Gemma 4 31B QAT Q4_0 | 23 GiB | Not run |

The Qwen4B artifact's **2,740,937,888-byte** size and pinned SHA-256
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`
were verified, along with structural bounds for all **426 tensors**. Its measured
run began with **6.18 GiB available system memory** and a **17.76 GiB shared Metal
allocation budget**. It used **8192 context / 1024 reserved output / 512 batch /
128 microbatch**, one slot, and completed native loading plus calibration in
**2.20 seconds** with the verified weights already local. Calibration measured
**37.48 tokens/sec**; short chat and function-call generation measured **37.27**
and **37.43 tokens/sec** respectively. These are short-run generation timings,
not end-to-end task latency distributions.

The loaded model was reused through the actual app gateway, bundled Goose ACP
agent, and frozen research MCP to read a fresh file containing a random UUID and
repeat its exact value. This entire run denied public outbound access and allowed
only loopback. The data is retained in
[the Qwen smoke record](qwen4-native-smoke.json); see
[native inference validation](native-inference-validation.md) for token counts,
the earlier explicit Slow mode case, and native shutdown evidence. The 4.5 GiB
planning estimate remains an estimate: **process peak RSS, long-context memory,
and the fifteen-task quality rubric have not been measured**.

The earlier Local Agent packaged app imported and checksum-verified the real
Qwen4B file into its normal-profile cache. At **4.7 GiB available memory**, setup
required explicit Slow mode before calibration. It then displayed **30.8
tokens/sec**, **Metal / 8192-token context**, and calibrated agent tools. A new
conversation requesting “Reply exactly: LOCAL_APP_READY” returned exactly
`LOCAL_APP_READY` through the packaged desktop and Goose and displayed task
completion. Web research was off, and the toy-fixture chats remained in a
separate isolated profile. This is a distinct observed GUI run, not the native
37.48 tokens/sec calibration or a task-quality benchmark. It used the app's
normal Electron renderer sandbox/context isolation; the external macOS
public-network-denial proof above did not cover this GUI run. The final Free
Local Agent package has not yet repeated this visible chat or calibration run.

Record measured tokens/sec, end-to-end task latency, actual memory, context
profile, and tool-calibration result only after a corresponding run completes.
A successful tool-call probe does not establish task quality or an accuracy gain.
Imported GGUF files start in chat-only mode; supported native templates and a
passing local tool calibration are required before enabling agent tools.

### Native platform status

| Target | Current evidence | Required follow-up |
| --- | --- | --- |
| macOS arm64, minimum macOS 13.3 | Final 81-test suite, package smoke, and four separate renderer checks passed; earlier native/GUI evidence recorded above | Final visible GUI/screenshots and real-chat revalidation after unlock; task quality, peak memory, and broader model/context benchmarks |
| Windows x64 | Native CI and Vulkan/CPU packaging configured | Execute CI, extract ZIP, verify drivers/CRT and run setup/task checks on Windows |
| Ubuntu x64 | Native CI and Vulkan/CPU packaging configured; bundled Linux symbol floors audited | Execute CI, install DEB and run setup/task checks on Ubuntu |

The Linux package requires `libc6 >= 2.34`, `libstdc++6 >= 12` (GLIBCXX 3.4.30),
and `libgomp1`; Vulkan acceleration also needs `libvulkan1` and a working system
GPU driver. An archive/symbol audit on macOS is not a successful Linux execution.
Windows runtime preparation includes signed Visual Studio redistributable files;
packaging configuration is not proof that a Windows installation works.

The macOS alpha is unsigned and not notarized. Windows/Linux native jobs have not
been executed locally, and their packages are unsigned. There is no automatic
update or completed signed-release claim. Use the checksums from the exact final
artifact, and keep platform launch behavior separate from model results.

### Evidence to append after a run

```text
Date / app revision / final artifact checksum:
OS version / CPU cores / GPU and driver / RAM / free memory:
Model revision and SHA-256 / backend / context profile:
Calibration: PASS | FAIL | NOT RUN; measured tokens/sec | unavailable:
Tasks passed / 15; safety failures and task-specific reasons:
Cold/warm latency; prompt/completion tokens | unavailable:
Peak runtime/backend/desktop memory and swapping:
Transcript / native test / screenshot artifact locations:
```
