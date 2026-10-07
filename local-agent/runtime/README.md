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

The five downloadable models pin exact publisher repository revisions, GGUF
filenames, byte sizes, SHA-256 values and licenses in `catalog.ts`. Qwen GGUFs
are published by Unsloth; Gemma QAT GGUFs are published by Google. They are text
models in this app; multimodal projectors are not downloaded. A GGUF import is
copied into the app cache, hashed, metadata-checked, and persisted by digest.
Generic imports remain chat-only. Only Qwen3.5/Gemma 4 architecture families
with native tool-template support and a successful explicit tool-call
calibration can gain agent tools. A curated model whose tool calibration fails
also remains available for chat.

## Main-process contract

- `start({signal?})` verifies engine integrity/version and probes hardware.
  Accelerated-loader failure falls back to the independently bundled CPU
  backend. No model process exists until `prepareModel`.
- `getStatus()` returns a serializable copy with hardware, selected inference
  profile, recommendation, download state and actionable errors.
- `listModels()` returns the five models and imports, installed state,
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
  The effective context may be below the requested profile if the model/server
  enforces a lower limit; request budgets must use the returned value.
- `setSlowMode(enabled)` unloads an idle model before changing the mode.
  A model requiring CPU or partial offload requires explicit Slow mode.
- `calibrateModel(id, {signal?})` verifies native template support and a local
  structured tool call without executing the generated tool.
- `requestJson(path, body?, signal?)` and `requestStream(path, body, signal?)`
  attach the private bearer token. Chat JSON has a 15-minute bound; properties
  and counts have a 60-second bound. Streaming relies on caller cancellation.
- `restartLowerProfile(signal?)` reloads the same verified model at a lower
  bounded profile. Call it only for an allocation failure before an action or
  streamed result has been committed. Transport, format and template failures
  do not justify inference replay. `isAllocationFailure(error)` is exported.
- `stop()` aborts loading, calibration, imports and downloads, waits for their
  cleanup, and terminates only the child owned by this runtime. New operations
  cannot race shutdown. It removes normal auth-file leases; startup removes
  stale app-created regular leases after a crash.

Events are `status`, `pull-progress` and `log`. Cancellation raises
`AbortError`; operational errors expose `RuntimeError.code`.

## Memory and privacy

The default profiles are 8K context with 512/128 batch/microbatch tokens, then
8K with 256/64, then CPU 4K with 128/32. Output reserves are 1024/1024/512,
reduced for a smaller effective native context. Only allocation failures
trigger bounded automatic retries. Every profile loads at most one model with
one inference slot. Prompt cache RAM, idle-slot caches, context checkpoints,
context shifting, Web UI, MCP proxy and built-in engine agent tools are
disabled. The native current request's KV working state still consumes memory.

Fit estimates separate weights, context, scratch, system reserve and GPU
budgets. The OS reserve is the larger of 3 GiB or 20% of RAM. Unified GPU memory
is counted once, and Metal's reported allocation budget is respected. Unknown
Vulkan devices are conservatively treated as shared memory unless a discrete
family is identified. macOS available memory includes reclaimable inactive
pages and avoids double-counting purgeable pages; memory is refreshed before
new loads. If available memory cannot hold weights plus minimum workspace,
loading is blocked until applications close. Estimates are provisional; native
loading and calibration provide the final check.

Shorter requests reduce KV/context and scratch demand, **not the model
weights**. All MoE weights still need backing memory. Memory mapping and CPU
fallback do not make an arbitrarily large model fit safely. Slow mode is a
performance tradeoff, not permission to force unbounded swapping.

The child inherits only a small OS-path/locale environment allowlist, excluding
cloud keys and `LLAMA_*`, MCP or RPC configuration. It receives an app-owned
model path, offline flags and a mode-0600 temporary API-key file. Its HTTP
requests refuse redirects. This runtime is not an OS sandbox against other
programs running as the same user. Do not expose executable paths, arbitrary
request bodies/paths, environment overrides, imported source paths or private
API keys through renderer/model tools. The Electron main process owns these
interfaces.

## Validation

Run `node --test local-agent/runtime/tests/*.test.ts` with Node 24.10 or newer.
Tests use tiny GGUF fixtures, injected artifact responses and owned loopback
fake-engine processes. They exercise cancellation, resumable download,
checksum rejection, metadata bounds, secret isolation, private authentication,
process reuse, shutdown races, memory classification, tool gating and bounded
fallback. Tests do not download production weights.

Native Mac Metal and CPU startup, token counting and generation are also
validated separately with an official tiny llama.cpp fixture. That fixture is
not an assistant-quality benchmark. Windows/Linux native execution requires
those platforms' CI runners.

Primary references:
[release](https://github.com/ggml-org/llama.cpp/releases/tag/v0.6.0),
[native API and properties](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/tools/server/server-context.cpp),
[engine arguments](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/common/arg.cpp),
[GGUF format](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md).
