# Native inference validation

Checked 2026-10-07 on macOS arm64, Apple M5, 10 CPU cores and 24 GiB RAM.

## Engine identity

The packaged resource engine is llama.cpp **v0.6.0**, official native asset
**b11429**, commit **d81235049384534c167caea52b85a694f6103d14**. The actual
binary reports 0.6.0-dev/build 11429/commit d81235049. Preparation verifies
archive SHA-256 and every bundled resource; runtime verifies the file manifest
and version before loading. Metal discovery reports Apple M5, approximately
18,186 MiB total device allocation budget. Unified RAM is counted once.

## Actual native smoke

Used the official llama.cpp test fixture from
[ggml-org/models stories260K.gguf](https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf).
The downloaded original SHA-256 is `270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d`. A simple text chat
template was inserted into its metadata for this smoke; the tensor data was
unchanged. The resulting fixture SHA-256 is `3328a6f186e512ea3e76452efd8fcf26de0f78e6a0cbad78518008caa1824e24`, at
`/private/tmp/local-agent-stories260K-chat.gguf`. It is not added to the app
model catalog or distributed with the app. Its Llama architecture remains
chat-only under the imported-model tool gate.

The actual pinned native engine passed:

- Private loopback startup on Metal with one slot, offline mode, engine UI and
  MCP/agent tools disabled; the runtime validated returned native properties.
- Checksum-verified generic GGUF import and native chat-template loading.
- Native `/v1/chat/completions/input_tokens` returned **8** tokens for
  “Once upon a time”; generation reported exactly **8 prompt tokens**,
  **16 completion tokens**, and **0 cached tokens**.
- Metal generated text: “vase was a big, shiny blue b”.
- Repeated preparation reused the same owned service URL/process.
- Batch reduction retained the model, then the final fallback used CPU.
- CPU token counting returned **8**, and CPU generation likewise returned
  **8 prompt tokens**, **16 completion tokens**, and **0 cached tokens**.
- Shutdown left the runtime stopped and removed its temporary auth lease.

The tiny fixture's native effective context is **2048**, below the requested
profile. The runtime now accepts only an actual bounded context at or below
the request and passes **2048 context/256 reserved output** to callers.

Observed tiny-fixture generation was about **586 tokens/s on Metal** and
**7146 tokens/s on CPU** in one short run. These figures describe a 260K test
model and launch overhead; they are **not assistant-model benchmarks** and
must not be extrapolated to 4B or larger models.

## Regression coverage

Runtime fixture tests cover pinned streaming/resumable downloads, cancellation
and partial retention, exact checksum rejection, hostile redirects, metadata
bounds and cancellation, private HTTP authentication, inherited-secret
isolation, owned-process reuse, allocation-only finite fallback, port
conflicts, modified/symlinked weight rejection, generic chat-only imports,
architecture/template/tool calibration gates, settings unloading, shutdown
races, stale auth leases and accelerated-loader CPU fallback. Tests use no
production weights or public network.

## Assistant-sized validation

The real pinned [Qwen3.5 4B Q4_K_M model](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/e87f176479d0855a907a41277aca2f8ee7a09523)
completed download and passed its full-file SHA-256 and structural validation
of all **426 tensors**, including descriptor types, alignment, offsets and
payload bounds.

- Artifact size: **2,740,937,888 bytes** (2.55 GiB).
- Pinned SHA-256: `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
- Preserved local artifact: `/private/tmp/local-agent-inference-smoke/models/Qwen3.5-4B-Q4_K_M.gguf`.
- Architecture: `qwen35`; its pinned native template reports tool-call,
  system-role, object-argument and string-content support.
- Initial available system memory: **6.18 GiB**, with **17.76 GiB** native
  Metal allocation budget. The model was classified as recommended.
- Selected profile: **8192 context / 1024 output**, Metal,
  **512 batch / 128 microbatch**, one slot.
- Native loading and automatic local tool calibration completed in
  **2.20 seconds** in this short run.
- Tool-calibration generation: **37.48 tokens/s**.

The exact chat request “Reply exactly: LOCAL_MODEL_OK” returned
`LOCAL_MODEL_OK`. The native full-chat token-count endpoint reported
**18 input tokens**, matching **18 generation prompt tokens**; generation
used **4 completion tokens**, **0 cached tokens**, and measured
**37.27 tokens/s**.

A request including a function schema forced
`local_smoke_probe({"word":"VERIFIED"})`, without executing an external
action. Its full templated input count was **285**, exactly matching native
generation usage. Generation used **30 tokens**, **0 cached tokens**, and
measured **37.43 tokens/s**.

The same loaded service was then reused through the app's budgeted inference
gateway and the actual bundled Goose ACP agent. With only local file reading
and project search enabled, the agent called `read_file` on a fresh fixture
containing a random UUID, received the file result, and reproduced that exact
value in its final response. This verifies real model → gateway → Goose →
frozen research MCP → model integration; it is one smoke case, not a broad
coding-quality benchmark.

The complete run used macOS `sandbox-exec` to **deny public outbound network**
and allow only loopback. An attempted public HTTPS request failed before
inference. Native UI, CORS proxy and native agent/MCP features were disabled;
private loopback authentication and one-slot ownership were validated.
Goose, the inference gateway and the owned model process all stopped cleanly.
Detailed measurements are saved in `.cache/qwen4-native-smoke.json` without
runtime API credentials.

An earlier run with only **4.81 GiB** available correctly required explicit
Slow mode. Its reduced Metal **8192 / 256 / 64** profile passed the same chat
and tool-generation checks at approximately **36–37 tokens/s**. This shows
that available memory affects the fit recommendation even on a 24 GiB system.
The catalog's **4.5 GiB working-memory estimate** separates 2.55 GiB weights,
0.95 GiB context allowance and 1 GiB scratch, with a separate 4.8 GiB system
reserve. These are conservative planning estimates; process peak RSS and
performance across long contexts were not measured in this smoke.

The development smoke downloader used bounded HTTPS byte ranges and
published the artifact only after final checksum verification. App downloads
remain sequential streaming with cancellation and resumable partial files.

Windows/Linux archives and bundle preparation were verified; actual native
execution on those systems remains a platform CI requirement.
