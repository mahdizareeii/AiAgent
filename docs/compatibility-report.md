# Free Local Agent alpha 0.2 compatibility report

This report separates observed setup and native checks from model estimates and
uncompleted task benchmarks. It covers **0.2.0-alpha.1**, including the current
Free Local Agent package and explicitly identified earlier Local Agent GUI runs.
See [build verification](build-verification.md) for current automated checks and
[the real-model rubric](alpha-validation.md) for the fifteen-task quality run.

## Development hardware observed

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

## Estimated model fit versus measured results

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

## Native platform status

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

## Evidence to append after a run

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
