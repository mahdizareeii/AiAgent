# Disabled Qwen80 certificate conversion draft

This directory is a review overlay. It does not change the production validator,
bundle, numerical certificate, model readiness, model defaults, or app consent.
No real report or certificate was generated while preparing or testing it.

`convert-qwen80-certificate.py` uses only Python's standard library. It never
launches a process, loads a model, downloads anything, or reads the source model
or fixture weight payload. It opens those files only to check their retained
native integrity fingerprints. It reads retained report/log files and hashes
retained capture binaries in 1 MiB chunks. On Darwin these reads use descriptor
local `F_NOCACHE` and disabled read ahead. Capture comparison is repeated at the
fixed `1e-5` absolute/relative tolerance and exact I32 equality. Selected expert
pairs must contribute exactly once; the converter also reads their retained
mask/ID captures. This is a passive recheck of a scoped computation run.

## Before conversion

The parent proof workflow must emit a fresh measured **8K/2048** run under
protocol `qwen80-standard-cpu-hybrid-v2-8k`. A successful prior 4K/1024 result
cannot be converted. Every contract below is mandatory; the converter rejects
legacy or incomplete evidence. The reviewer must inspect native provenance and
confirm these records came from an actual run. Matching JSON and hashes alone
cannot establish origin against deliberately forged evidence.

`process-report.json` must have schema version 1; evidence kind
`measured-native-qwen80-proof`; exact scope
`representative-experts-and-two-hybrid-layers`; the protocol above;
`passed=true`; `issuedAppCertificate=false`; `fullModelLoaded=false`;
`resourcesVerified=true`; `sourceFingerprintUnchanged=true`;
`ownedProcessesStopped=true`; and the exact pinned base, worker patch, current
native resource manifest digest, ordered artifact set digest and template digest.
It must also retain `diagnosticEvidenceVersion=2` and
`evidenceInventoryComplete=true`. Its two exact private fixture build rows retain
each binary SHA256 and the current corresponding C++ source SHA256; missing,
stale, incomplete, or mixed diagnostic builds are rejected.
Its `profile` is the full computation contract from `RUN_PROFILE` in the
converter: standard CPU, no extra buffer types or repacking, context 8192,
output 2048, batch 64, microbatch 16, four decode/batch threads, 30 cache slots,
F16 K/V, no full SWA, one sequence, two descriptor local uncached I/O workers.
The exact Qwen computation profile additionally requires `kvUnified=true`,
`nRsSeq=0`, and `checkpoints=0`. The ordinary CPU reference uses the same KV
layout; the native API fixture has no server checkpoints. Gemma's existing
profile is a separate contract and is not changed by these Qwen fields.

`resolvedNativeLayout` must be retained in the process report, every graph
report, every graph `plan`, every executed graph `run`, and the comparator's
retained result. It contains exactly
the measured layout fields `contextTokens=8192`, `contextPerSequence=8192`,
`batchTokens=64`, `microBatchTokens=16`, `slots=1`, `kvUnified=true`, `nRsSeq=0`,
`cacheTypeK=f16`, and `cacheTypeV=f16`. The proof must emit those fields from
resolved native cparams/KV types, separately for planning and execution.
Requested JSON constants cannot substitute for missing resolved evidence. The
converted report keeps the same resolved layout. False unified KV, nonzero
recurrent sequence count, checkpoint changes, different precision or context
per sequence invalidate conversion.

The eleven `steps` must be complete and ordered as source shard integrity 1–4,
expert parity, fixture integrity, ordinary/streamed no allocation planning,
ordinary/streamed inference, and comparison. All must have actual positive wall
time, exit zero and no stop reason. The retained samples must show normal
pressure, at least 1 GiB of available headroom, controller footprint/RSS no
greater than 256 MiB, and owned child footprint/RSS no greater than 3.5 GiB.

The build record retained inside the process report and the process report itself
must also carry matching `nativeResourceIdentity` and `nativeResourceDigest`.
The identity has exactly `schemaVersion=1`, `baseCommit`, `patchSha256`, `target`,
`backends`, `planner`, `integrity`, and `nativeFiles`. Those fields are projected
from the actual integrity-verified native resource manifest used for compilation
and execution. `nativeFiles` is exactly the `worker/` rows, sorted in ASCII path
order, with objects `{path,size,sha256}`. Arrays retain their original order.
Paths must be unique and safe, sizes positive safe integers, SHA values exact,
and every backend/planner/integrity executable must be covered. The other fields
retain their exact current native manifest values, including backend arguments
and planner/integrity source digests. Changed same-patch native binaries,
libraries, planner/helper, or backend arguments invalidate the binding.
Native paths must be flat `worker/[A-Za-z0-9._-]+` filenames. The inventory must
cover `libllama.0.dylib`, `libggml.0.dylib`, `libggml-base.0.dylib`, and
`libggml-cpu.0.dylib`. The planner and integrity executables must be exactly
`worker/llama-plan-ssd` and `worker/llama-hash-ssd`. Every backend must explicitly
declare `libraryDirectory=worker` and its string array `arguments`; optional
defaults or alternate covered helper names are rejected. These checks match the
draft runner and runtime identity builders.

The native digest is SHA256 of compact UTF-8 JSON with recursively ASCII-sorted
object keys, preserved array order, no ASCII escaping, and safe integer numeric
values. This is the shared TS/Python encoding. Full `manifest.json`, validation
reports and licenses are excluded from this identity to avoid circular binding
when the reviewed report is added to the bundle. The existing full manifest
digest stays in the retained run for audit; current acceptance must compare the
stable native identity and its digest against the current verified bundle.

`evidenceInventory` is a dictionary keyed by the exact basenames in `FILES`:
source/fixture JSON, four source integrity logs, separate fixture integrity log,
expert log, four graph report/log pairs, two capture binaries, comparison JSON,
and comparison log. Each row must be exactly
`{sha256, sizeBytes, fingerprint}` using the native seven-field fingerprint.
The process report does not include a self hash; the converter records its exact
read hash in `measuredProof.processReportSha256`. Every file is rehashed and
fingerprint checked. Regular files only; a symlink leaf is rejected. Report/log
reads are capped at 32/64 MiB, captures at 1 GiB each. No inventory is invented
when converting old outputs.

The source proof must additionally retain actual `architecture=qwen3next` and
`geometry={layers:48, expertsPerLayer:512, activeExperts:10,
minimumSlotsPerLayer:30, expectedRoutedTensorGroups:48,
originalTensorDescriptors:807}`. All four immutable published official files
must retain separate uncached native full SHA, byte count, helper provenance
and current fingerprints. The model digest is the existing runtime's ordered
compact JSON digest, not the first shard's SHA. The actual template must match.
Source/fixture full native hash outputs remain separately bound to their logs.
Every copied fixture tensor must retain equal source-copy/destination-readback
SHA values, bounded offsets, original layers 0 and 3 remapped to 0 and 1, both
complete routed groups and the original embedding/head/norm globals.

The actual expert `SSD_PARITY_METADATA.layouts` is a list of
`{signature, groups, firstGroup, lastGroup}` generated from the surveyed headers.
It must partition all 48 groups. Both endpoints of each distinct actual layout
must finish five actual cases: cold decode, warm decode, eviction/reload, four
full waves, and a partial final wave. Each `SSD_PARITY_CASE` must retain `layer`,
the exact case/tokens/waves, passed=true, nonfinite=0,
elementsOutsideTolerance=0, rawBytesEqual=true,
allSelectedPairsContributeOnce=true, both fixed tolerances, and finite maxima.
Every representative group's populated buffer memory snapshot must confirm the
actual standard CPU/no repack/four-thread policy. The final record must match the
one retained inside the process report.

Each graph JSON additionally carries the exact protocol, current resource
manifest digest, full `RUN_PROFILE`, and its existing source/fixture/worker
identities. Its `plan.profile` carries the actual same computation fields with
cache slots zero for the ordinary reference and 30 for streamed execution.
Planning stays `noAlloc=true` / zero model payload allocation; exact native
steady/loading/required peaks must fit its retained limits. The ordinary and
streamed inference reports must include complete six-case, ten-step, two-layer
captures with aligned common diagnostics, exact I32 router IDs, finite F32
outputs, all wave IDs/masks, original-ID contiguous copies and all output logits.
The comparison JSON has the protocol/profile, fixed tolerances, complete node
and wave coverage, and explicit remaining coverage gaps. The process report's
comparison object must equal the retained comparison JSON.

Every graph report, including metadata-only plans, and the comparison require
`diagnosticEvidenceVersion=2`, the current `qwen80-graph-parity.cpp` SHA256 in
`diagnosticSourceSha256`, and
`residualAliasContract=qwen3next-residual-add-no-cvec-v1`. The build injects that
actual source digest as a quoted C++ string macro. Each executed mode requires
20 unique residual alias witnesses: all six cases, ten steps and two layers,
keyed by exact case/step/layer. Every capture reference has exact name and
occurrence0. Native step-local tensor IDs derive from actual pointers; the
pointer-to-capture map is reset before each decode step.

Pinned Qwen construction's residual ADD is renamed from `post_moe` to `l_out`
when the control vector is absent. No second payload may be fabricated for that
semantic alias. A witness must bind the actual captured `l_out-N` to the exact
earlier same-step `ffn_out-N` and `attn_residual-N` captures in that operand order.
Its native operation must be ADD with only those two nonnull parents, three
distinct native tensor identities, identical contiguous F32 shape
`[2048,tokens,1,1]`, no view and no control vector. Witness IDs must equal the
IDs retained in the physical captures. Actual `attn_residual` captures also join
ordinary/streamed common-node comparison. The 20 semantic alias roles per mode
are separate from physical capture counts and cannot replace any diagnostic.

The comparator records20 measured residual arithmetic rows for each mode and
must fail if any row fails. The converter independently validates that complete
summary, all witness topology and every retained operand/output payload. It
rereads bounded three-tensor groups (at most128KiB each), rounds each operand
sum to binary32, rejects nonfinite inputs/output/sum and overflow, and applies
the unchanged `1e-5 + 1e-5*abs(reference)` tolerance. Matching hashes or cross-mode
values cannot replace this ADD check. The unchanged60-second comparison cap
and256MiB controller cap remain mandatory. Failed8K-v1 evidence cannot satisfy
this version2 contract; fresh8K-v2 compilation and a complete new actual run
are required. No source-only update creates a passing report or certificate.

## Reviewed output

Without `--reviewed`, writing is rejected **before** evidence reads. Use
`--validate-only` to passively inspect retained evidence without a write.
Actual reviewed conversion additionally requires an explicit **new** output
directory. It writes only `validation/qwen3-coder-next-80b-standard-cpu-8k.json`
and `qwen80-numerical-configuration.json` there with exclusive creation and
private modes. Never point conversion at production resources. Configuration
fields match the existing `SSDNumericalConfiguration` type; the report SHA is
computed from the actual emitted report bytes. The current production Gemma
validator still rejects this Qwen scope until separately reviewed integration.

The report includes the required `measuredProof` summary: exact protocol;
verified set, expert, hybrid, stable source and cleanup booleans; positive actual
node/element/layout/representative counts; zero outside-tolerance/ID/nonfinite
counts; selected pairs once; and comparison/process/expert-log SHA bindings.
It preserves the steps and retained inventory. Full measured samples remain in
the raw process report, bound by `measuredProof.processReportSha256`; they are
not embedded in the emitted report. Instead `measuredRun.resourceSummary` is
independently recomputed from every validated sample and has exactly these eight
fields: `sampleCount`, `ownedChildSampleCount`, `minimumAvailableRamBytes`,
`maximumControllerRssBytes`, `maximumControllerPhysicalFootprintBytes`,
`maximumOwnedChildRssBytes`, `maximumOwnedChildPhysicalFootprintBytes`, and
`allPressureNormal=true`. Both counts and all peaks must be positive. At least
one actual child measurement is required, normal pressure/headroom and the same
controller/child caps remain mandatory, and no omitted bad sample can be hidden
by reduction. If a process summary is also present it must match the full raw
samples exactly. The converter rejects an emitted report above the unchanged
1 MiB runtime limit before any write. It explicitly
does not establish all 48 layers, Metal, Chat/tools, coding completion or model
quality. It grants no app consent.

## Offline checks

Run `python3 -B test_qwen80_certificate_conversion.py` inside this directory.
Positive schema fixtures exist only in memory. Negative tests cover unreviewed
and absent evidence, mismatched shards/order/set/template/revision/helper,
changed source fingerprints, separate copied fixture integrity, old profiles,
wrong scopes, incomplete/fake/failed processes, pressure and resource failures,
layout endpoint/case omissions, actual retained numeric mismatches, missing
hybrid diagnostics, router types, fixed tolerance, wave coverage, JSON ambiguity,
symlink reads and retained evidence tampering. No real certificate is written.
Additional checks reject changed same-patch native libraries, mixed/unsafe/
duplicate/reordered native inventories, uncovered executables, backend/helper/
planner drift, bad canonical encoding, inconsistent resource summaries and
oversized emitted reports. A long raw sample series is tested to reduce to a
small positive summary while retaining its full process hash binding.
