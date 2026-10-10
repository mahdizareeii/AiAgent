# Free Local Agent alpha 0.2 verification status

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
