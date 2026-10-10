# Free Local Agent compatibility report

## Current 0.4.0-alpha.1 workspace/plugin update — 2026-10-10

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
