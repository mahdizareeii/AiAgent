# Alpha 0.2 verification status

This report concerns **0.2.0-alpha.1**, which replaces the earlier Ollama alpha
with bundled inference and adds hardware fit, GGUF import/calibration, utility
controls, token-budget handling, and read-only stage checkpoints.

The results below were completed on macOS arm64 on 2026-10-07, including tensor
validation, RAM-only CPU fallback, cancellation checks before mutation, and owned
command-process cleanup. No previous alpha result or artifact checksum is used
as evidence for this version.

| Check | Current result |
| --- | --- |
| Strict TypeScript and desktop production build | Passed |
| Full JavaScript/TypeScript suite: runtime, downloads, hardware/GGUF, token budgets, checkpoints, permissions, undo, cancellation | 81/81 passed with public network denied and loopback allowed |
| Source-built offline Goose with deterministic local provider | All six integration cases passed; included in the full suite |
| Research tests | 59/59 passed on rerun |
| Frozen-sidecar protocol tests | 5/5 passed on rerun |
| Offline Goose/inference packaged manifests, native version, and packaged MCP/approval smoke | Passed with public network denied and loopback allowed |
| Current macOS arm64 package first launch | Exact packaged app visually inspected; hardware/runtime ready and web research off |
| Packaged import → chat-only model → Start a conversation → native chat | Passed using the 260K toy GGUF fixture; no catalogue-model quality claim |
| Final packaged Qwen4B import, Slow mode, calibration, and Goose chat | Passed in the normal profile; 30.8 tokens/sec measured; returned exactly `LOCAL_APP_READY`; web research off |
| Windows x64 ZIP and Ubuntu x64 DEB | Native CI configured; not executed locally |
| Pinned Qwen3.5 4B native chat, tool calibration, token counting, and actual Goose/MCP file read | Passed with public network denied; SHA-256 verified; Metal 8K context / 512 batch / 128 microbatch; 37.48 tokens/sec calibration |
| Broad catalogue-model task quality, representative latency, and peak memory | Fifteen-task rubric not run; peak RSS and long-context behavior not measured |
| Final current ZIP checksum | `a4ee4365964395ca38843650b670c1fb129a5fe6dcca58e31aa3fe1124272f9d` |

The final macOS archive is `Local Agent-0.2.0-alpha.1-arm64-mac.zip`,
217,046,083 bytes. Its native package smoke passed after the final rebuild.

The network-denied checks ran under an actual macOS `sandbox-exec` profile that
denied public outbound access and allowed only localhost communication. A separate
HTTPS request to `example.com` was confirmed blocked. The native processes, MCP
smoke, and automated checks ran under that restriction.

The full Electron GUI could not start inside that additional macOS sandbox:
Chromium sandbox initialization failed. GUI inspection instead used the normal
app with Electron renderer sandboxing, context isolation, Node integration off,
and the renderer's connection-blocking CSP. The external public-network denial
proof therefore applies to the native/MCP/test checks, not to the GUI run. This
test profile is not an OS command sandbox in the shipped app.

The new package smoke verifies the offline Goose feature/hash manifest, the
bundled inference pin and complete file inventory, native engine version/flags,
packaged Electron/ASAR action bridge, a denied edit with unchanged file content,
`inspect_file` and verified file reading, and web tools absent by default. It lists
web tools only in an explicitly opted-in sidecar and calls no public network tool.
No model is loaded/downloaded by that smoke test.

The separate packaged UI exercise used an isolated profile and a checksum-verified
260K toy GGUF with a simple chat template. Import was shown as chat-only, the
conversation started, and the request “Once upon a time” produced a native local
reply. This verifies the connected UI/import/chat path, not useful assistant
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

The exact final packaged app was then exercised in its normal user profile with
the real Qwen4B file. It copied the local artifact into its cache and verified
its checksum. With only 4.7 GiB available memory, setup required explicit Slow
mode before calibration. Calibration passed and the UI displayed **30.8
tokens/sec**, **Metal / 8192-token context**, and calibrated agent tools. Starting
a conversation and asking “Reply exactly: LOCAL_APP_READY” returned exactly
`LOCAL_APP_READY` through the packaged desktop and Goose, then displayed task
completion. Web research remained off. The earlier toy chats stayed in their
separate isolated profile.

This GUI observation is a distinct run from the 37.48 tokens/sec native smoke.
It used normal Electron renderer sandboxing and context isolation, with the
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
