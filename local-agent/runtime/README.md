# Bundled local inference runtime

`LocalInferenceRuntime` is a dependency-light TypeScript module for the Electron
main process. It owns one offline, authenticated llama.cpp server on numeric
loopback. It requires no Ollama installation, service, cloud account or API key.
Starting the runtime verifies its bundled engine and detects hardware without
downloading weights.

```ts
import { LocalInferenceRuntime } from './runtime/index.ts';

const runtime = new LocalInferenceRuntime({
  dataDirectory: path.join(app.getPath('userData'), 'gguf-runtime'),
  resourcesDirectory: path.join(process.resourcesPath, 'inference'),
});
await runtime.start();
const models = await runtime.listModels();
// Call after a user chooses Download. Weight files can be many gigabytes.
await runtime.pullModel('qwen3.5:4b', { signal, onProgress });
const prepared = await runtime.prepareModel('qwen3.5:4b', { signal });
const count = await runtime.requestJson('/v1/chat/completions/input_tokens', {
  model: prepared.model, messages, tools,
}, signal);
// The caller budgets the complete native-formatted input, reserved output and
// headroom before inference. Larger sources must be processed in stages.
await runtime.stop();
```

The engine is **llama.cpp v0.6.0**, commit
`d81235049384534c167caea52b85a694f6103d14`. That release's official native asset
is named **b11429**, and its binary reports `0.6.0-dev`, build 11429, the same
commit. Both the preparation script and runtime verify these identifiers.
Preparation pins archive SHA-256 values and records each bundled executable,
library and license in `resources/inference/manifest.json`.

The downloadable models pin exact publisher repository revisions, GGUF
filenames, byte sizes, SHA-256 values and licenses in `catalog.ts`. The coding
candidates are the selected LM Studio Qwen3.8-27B Q4_K_M conversion and Meta's
official Muse Glimmer30B Q4_K_M conversion, plus separately identified Bartowski
Q3_K_M variants. Q3 files, templates and profiles require fresh verification;
they inherit family generation settings, never Q4 calibration or task evidence.
The earlier Qwen GGUFs are published
by Unsloth; Gemma QAT GGUFs are published by Google. They are text
models in this app; multimodal projectors are not downloaded. A GGUF import is
copied into the app cache, hashed, metadata-checked, and persisted by digest.
Generic imports remain chat-only. Only Qwen3.5/Gemma 4/Muse Glimmer architecture families
with native tool-template support and a successful explicit tool-call
calibration can gain agent tools. Earlier curated models whose tool calibration fails remain available for chat.
The two pinned coding candidates require passing Chat and tool-result checks
before their native mapped-weight profile becomes ready.

## Main-process contract

- `start({signal?})` verifies engine integrity/version and probes hardware.
  Accelerated-loader failure falls back to the independently bundled CPU
  backend. No model process exists until `prepareModel`.
- `refreshHardware({signal?})` refreshes available RAM and the native Metal
  allocation budget without loading weights. `start` reuses an already ready
  runtime, so the desktop's hardware check calls this method explicitly.
- `getStatus()` returns a serializable copy with hardware, selected inference
  profile, recommendation, download state and actionable errors.
  `profileSignature` is stable JSON of the pinned engine commit, memory mode,
  backend, confirmed context/output limits, batch/microbatch and one slot. The
  qualified profiles also bind their model-specific generation policy, K/V cache
  precision, flash attention, explicit CPU/GPU weight placement and verified native memory-plan digest. It
  is null when no profile exists and matches `PreparedModel.profileSignature`
  in every mode; a smaller native context or profile change changes identity.
- `listModels()` returns the catalog and imports, installed state,
  quantization, license, source URL, memory estimates, fit reason and measured
  generation speed when available.
- `pullModel(id, {signal?, onProgress?})` streams a pinned HTTPS artifact into
  a `.part` file. Retry resumes with HTTP Range. Exact size, SHA and bounded
  GGUF metadata are verified before atomic publication. `cancelPull()` aborts
  an active download or import and leaves resumable download bytes.
- `importModel(sourcePath, {signal?})` is a **trusted main-process** operation
  called after a file picker grants access. It never downloads remote URLs.
- `inspectModel(id, {signal?})` verifies regular-file size, checksum and chat
  metadata. Reuse requires unchanged inode, device, size, modification and
  change timestamps. A new app process hashes installed weights again.
- `prepareModel(id, {signal?})` reuses an already loaded verified model or
  starts one owned server. It returns `{model, sourceModel, baseUrl, apiKey,
  contextTokens, outputTokens, toolCapable, digest, measuredTokensPerSecond?}`.
  `baseUrl` is the loopback root, without `/v1`. The model is an app-local alias.
  Qualified coding models additionally return `generationPolicy` and sampled
  `calibrationMeasurements` and `nativeMemoryPlan`. Status exposes
  `preparationStage` as planning/loading/probing while preparation is pending.
  Their effective native context and initialized K/V precision/flash attention
  must match the explicit profile; mismatches cannot establish readiness. Earlier
  models may return a smaller effective native context; request budgets must
  always use the returned value.
- `setSlowMode(enabled)` unloads an idle model before changing the mode.
  Automatic mode requires explicit Slow mode for a model requiring CPU or partial offload.
- `setMemoryMode('automatic' | 'low-memory' | 'experimental-disk')` unloads an
  idle model and invalidates prior experimental probes. Explicit Low memory uses
  only Metal 16K/4K output/64/16 with Q8_0 K/V and flash attention for the two
  coding candidates; it has no higher-memory fallback. Earlier models retain
  4K/128/32 as their first Low memory profile.
- `startExperimentalTrial(id, {signal?})` is an explicit main-process operation,
  initially supported on macOS ARM64. It verifies the artifact, unloads the
  previous app-owned model, samples current memory, then loads CPU-only mmap
  with supported lazy reads, fit off, F16 KV and a single 4K slot. A required
  local Chat probe and eligible native tool-format probe share five minutes;
  engine loading is bounded to ten minutes. Failed tools retain Chat-only
  capability. `cancelExperimentalTrial()` invalidates the probe and unloads
  the owned model. A model switch never starts an experimental trial.
- In experimental mode, `prepareModel` only reuses a still-running trial with
  matching model digest and profile signature. A restart requires another
  explicit trial. `getStatus().experimentalTrial` includes probe outcomes,
  sampled resident/available memory and pressure, and separately reported
  rounded engine mmap-buffer/lazy-tensor sizes. Null means unmeasured.
- `calibrateModel(id, {signal?})` verifies native template support and a local
  structured tool call without executing the generated tool.
- `requestJson(path, body?, signal?)` and `requestStream(path, body, signal?)`
  attach the private bearer token. Chat and streaming default to a one-hour
  transport bound; properties and counts retain a 60-second bound. Use
  `setExecutionRequestTimeout(remainingMs)` and caller cancellation for the
  remaining active task deadline. Health queries use a shorter explicit bound.
- `restartLowerProfile(signal?)` reloads the same verified model at a lower
  bounded profile. Call it only for an allocation failure before an action or
  streamed result has been committed. Transport, format and template failures
  do not justify inference replay. Experimental disk rejects automatic profile
  recovery. `isAllocationFailure(error)` is exported.
- `stop()` aborts loading, calibration, imports and downloads, waits for their
  cleanup, and terminates only the child owned by this runtime. New operations
  cannot race shutdown. It removes normal auth-file leases; startup removes
  stale app-created regular leases after a crash.

Events are `status`, `pull-progress`, `log` and `executionStopped`. The last
event identifies an owned model process that stopped or failed its memory
check; SSD events also carry a trial ID. Cancellation raises
`AbortError`; operational errors expose `RuntimeError.code`.

## Memory and privacy

Qwen3.8-27B and Muse Glimmer30B load alone on Metal with one slot. For their Q4
files, on machines with at most 24 GiB RAM Automatic begins with 16K context, 4K combined output,
batch 64/microbatch 16, F16 K/V cache and enabled flash attention. Machines with
more RAM begin with 32K/8K output/128/32, then 16K F16. A measured allocation or
admission failure may try 16K Q8_0 K/V with flash attention. Explicit Low memory
starts only a 16K Q8_0 profile with the same output/batch limits and supported
partial CPU placement: Qwen requests 64 GPU layers (its chooser includes one
skipped MTP slot), moving two active blocks plus output/output-norm weights to
CPU. Muse requests all chooser layers but overrides blocks 0, 1 and 10–13 to CPU:
these are the physically first six blocks in its lexicographic tensor
order. Its output remains on GPU and its KV placement follows the native planner.
CPU weights retain GGUF precision, with repacking disabled and four decode/batch
threads. This reduces the Metal mmap span for each conversion's tensor order and
can reduce speed. The explicit candidate sets `metalResidency: 'disabled'`, using
the pinned engine's `GGML_METAL_NO_RESIDENCY=1` only in the sanitized planner/server
environment. Ambient GGML variables remain stripped. This setting avoids native
residency sets and their default 180-second wiring heartbeat; GPU commands can
still make memory resident, so the same memory accounting and guards apply.
There is no upward fallback. This is a separate user-selected
profile, not recovery from a pressure stop. Pressure, missing
telemetry, integrity errors and transport failures do not restart inference.
Native auto-fit remains off. Q4 Automatic still requests all layers on Metal;
neither mode substitutes a CPU-only or 4K profile. Exact native context and every
initialization K/V/flash-attention record must confirm the selected profile before
probes. Mixed placement additionally requires exact header-derived CPU/Metal mmap
spans (allowing only native log rounding), the pinned layer-count log and four
decode/batch threads and exact `use residency sets = false` startup evidence.
Missing, malformed or contradictory residency evidence, CPU repacked buffers or unexpected spans
cannot establish readiness. The requested count includes the pinned chooser's
output/MTP convention and is not itself proof of actual tensor placement.
Earlier mixed profiles, including fourteen CPU blocks on Qwen, stopped on warning
pressure before coding. A twenty-four-block Qwen profile stayed under normal
pressure through a 90-second VM trace but its fixed checks exhausted their shared
five-minute deadline: prompt processing measured about 2.5 tokens/s. No coding
case ran and cleanup completed. The current no-residency candidate restores more
GPU work for a separate explicit calibration. Header/native no-allocation checks
confirm only planned allocations; actual loading, probes and task qualification
remain required. The pinned mmap loader advises prefetching
the whole GGUF and has no macOS no-prefetch flag; free/file-cache estimates and
the independent kernel pressure signal are separate required checks.

The exact Q3 IDs use a separate 16K/Q8/4K-output, 64/16 batch profile in Automatic
and Low memory, with the same no-repack/four-thread/no-residency settings. Qwen Q3
initially requests 64 GPU layers and CPU head/norm placement. Muse Q3 derives its
ten physically first complete blocks from the fully SHA-verified header instead
of reusing Q4 indices. A head or norm anchoring the GPU mmap span inside that
prefix moves to CPU; an output norm at the file's end stays on GPU when possible.
Exact indices and independent head/norm choices bind the profile and native plan.
The CPU embedding may be stored at the file's end; its mmap view can overlap the
Metal view. Placement is derived from complete block positions, and physical
weight pages still count once rather than adding overlapping virtual spans.
Missing/interleaved blocks or a prefix that cannot reduce the actual Metal span
fail before planning. These choices permit fresh calibration, not a fit or coding
quality claim; no higher-memory or pressure-retry fallback is used.

After full pinned SHA and metadata verification, the integrity-covered official
b11429 `llama-fit-params` utility plans allocations without loading weight
payloads. Its native model/context/compute rows are checked and rounded upward
from integer MiB. Metadata planning has a 30-second deadline and a sampled
512 MiB process bound. The complete artifact size conservatively bounds GPU
mmap spans, including gaps and skipped tensors; the larger of that size and the
summed native host/device weight estimates is counted once in unified RAM.
GPU admission uses that span plus native Metal context/compute and 256 MiB
headroom. Total RAM uses weights once plus all native context/compute and
1 GiB process headroom, while preserving the existing OS capacity reserve
(`max(3 GiB, 20% of RAM)`, 4.8 GiB on a 24 GiB Mac). Model, template, complete
engine inventory, planner, exact profile and allocation rows bind plan identity.
Mixed profiles also bind the native layer/CPU settings and verified tensor
positions. The full artifact remains the conservative GPU admission bound even
when the confirmed Metal span is smaller; overlapping CPU/Metal virtual mappings
are not extra physical copies.

Cold mmap calibration requires normal memory pressure and current reclaimable
cache sufficient for planned nonmapped workspace plus the OS reserve. It does
not assume active anonymous memory is free or require all mapped weights to be
free RAM before loading. During loading/probes, a serialized 250 ms monitor
checks the owned process; after readiness it runs every two seconds and before
generation. The integrity-covered native sampler verifies same UID and direct
parent ownership before reading RSS/physical footprint. Those overlap: the
larger value is checked, never their sum. Warning/critical pressure, less than
1 GiB retained headroom, exceeding the smaller of planned working memory and
RAM minus OS reserve, changed artifacts, or unavailable/stale telemetry stops
only the owned process without replay. Warm reuse does not charge cold weights
again. These sampled checks cannot guarantee an instantaneous OS allocation cap.

Fixed Chat, native tool-call and real tool-result continuation checks share five
minutes and use the full profile output allowance. Preparation stays pending
until those checks pass. Muse uses low reasoning for helpers/probes, high
reasoning for coding and always thinks; Qwen uses medium/xhigh coding effort and
disables thinking for helpers/probes. Combined output and the caller's execution
deadline bound generation; Muse's native reasoning-budget switch is not assumed
to cap reasoning. Separate real coding checks are required for quality/default
adoption. Both pinned large artifacts are now downloaded and SHA-verified, but
neither model has completed native/coding qualification. The measured Qwen16K
F16 attempt at 2026-10-14T11:53:23.888Z stopped solely on warning pressure:
1.064 GiB available, 4.174 GiB RSS and 1.336 GiB physical footprint against its
17.887 GiB planned resident bound. No task case ran and the owned engine stopped.
This motivates a fresh explicit 16K Q8_0 trial without relaxing any guard; it
does not establish that Q8_0 or Muse can load or finish tasks. Provisional
partial-header plans alone are not model-loading evidence.

The earlier models' default profiles are 8K context with 512/128 batch/microbatch tokens, then
8K with 256/64, then CPU 4K with 128/32. Output reserves are 2048/2048/1024,
also capped at one quarter of the confirmed effective native context. Only allocation failures
trigger bounded automatic retries. Every profile loads at most one model with
one inference slot. Prompt cache RAM, idle-slot caches, context checkpoints,
context shifting, Web UI, MCP proxy and built-in engine agent tools are
disabled. The native current request's KV working state still consumes memory.

Fit estimates separate weights, context, scratch, system reserve and GPU
budgets. The OS reserve is the larger of 3 GiB or 20% of RAM. Unified GPU memory
is counted once. Metal's reported recommended working-set size is an advisory
performance threshold, not physical free VRAM; the app conservatively respects
it for the planned GPU allocations rather than comparing total RAM use with it. Unknown
Vulkan devices are conservatively treated as shared memory unless a discrete
family is identified. macOS reclaimable-memory estimates use free pages plus the larger of
file-backed and purgeable pages. File-backed includes active/inactive/speculative
external pages, so speculative pages are not added twice; occupied anonymous
pages are excluded. Dirty file pages may require writeback. The systemwide
`memory_pressure` percentage also includes active anonymous memory and is not
used as allocatable bytes. Memory is refreshed before new loads. Earlier models
retain their conservative weights-plus-workspace admission; the two coding
candidates use the verified, monitored mmap calibration described above.

Shorter requests reduce KV/context and scratch demand, **not the model
weights**. All MoE weights still need backing memory. Memory mapping and CPU
fallback do not make an arbitrarily large model fit safely. Slow mode is a
performance tradeoff, not permission to force unbounded swapping.

Experimental disk is a separate opt-in trial, not a new fit classification.
Pinned llama.cpp only lazy-reads tensors explicitly marked by their
architecture, such as per-layer embeddings; selecting mmap does not make
every dense or expert tensor lazy. The runtime reports the tensors the engine
actually enabled, including zero when none were eligible. Rounded mmap buffer
sizes are not RSS and do not establish how much of a model is resident.

After unloading the prior app-owned model, the trial requires context/scratch
headroom and sets its sampled resident stop threshold to
`min(total RAM - existing OS reserve, available RAM - 1 GiB)`. Every two seconds,
macOS `vm_stat`, memory-pressure state and only the owned process's RSS are
read. Reaching the resident threshold, critical pressure, two consecutive
samples below 512 MiB available, or missing/stalled measurements stops the
owned model and invalidates its probe. The watcher remains active after a
successful probe. This is sampled protection, not a hard memory limit or a
quality guarantee. The app does not alter paging settings or other programs.

The child inherits only a small OS-path/locale environment allowlist, excluding
cloud keys and `LLAMA_*`, MCP or RPC configuration. It receives an app-owned
model path, offline flags and a mode-0600 temporary API-key file. Its HTTP
requests refuse redirects. This runtime is not an OS sandbox against other
programs running as the same user. Do not expose executable paths, arbitrary
request bodies/paths, environment overrides, imported source paths or private
API keys through renderer/model tools. The Electron main process owns these
interfaces.

For the two coding candidates, model inference and preparation helpers use only
the owned loopback engine and web research is disabled. On supported macOS,
approved commands deny direct non-loopback sockets, allow loopback for local
development, and remove inherited HTTP/HTTPS/ALL proxy settings, npm proxy
settings and Node environment-proxy forwarding. Other project environment
variables remain available. This direct socket policy does not establish that
an existing local service cannot relay traffic elsewhere.

## Validation

Run `node --test local-agent/runtime/tests/*.test.ts` with Node 24.10 or newer.
Tests use tiny GGUF fixtures, injected artifact responses and owned loopback
fake-engine processes. They exercise cancellation, resumable download,
checksum rejection, metadata bounds, secret isolation, private authentication,
process reuse, shutdown races, memory classification, tool gating and bounded
fallback. Tests do not download production weights.
Experimental tests additionally cover explicit probe identity, Chat-only tool
failure, initial headroom, unified memory, immediate cancellation, monitoring
failure, pressure/residency stops and shared loading/calibration deadlines.

Native Mac Metal and CPU startup, token counting and generation are also
validated separately with an official tiny llama.cpp fixture. That fixture is
not an assistant-quality benchmark. Windows/Linux native execution requires
those platforms' CI runners.

Primary references:
[release](https://github.com/ggml-org/llama.cpp/releases/tag/v0.6.0),
[native API and properties](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/tools/server/server-context.cpp),
[engine arguments](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/common/arg.cpp),
[GGUF format](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md).
