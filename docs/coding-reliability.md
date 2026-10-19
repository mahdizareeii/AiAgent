# Local coding qualification

The implementation adds Qwen3.8 27B and Muse Glimmer 30B to the local catalog.
Weight acquisition uses public downloads; inference, reasoning history, project
tools, and reports stay on the computer. No paid service or hosted model is used.

Both original Q4 artifacts are fully downloaded and verified. They stopped on
memory pressure or exceeded the fixed calibration deadline on this 24 GiB Mac.
Both separate Q3_K_M variants are fully downloaded, SHA/GGUF-verified and installed
in the regular app cache. These lower-memory variants retain the same upstream models.
Their precision, identity and qualification evidence remain separate from Q4.
Qwen Q3 has completed an independently verified exact-file task, a real
JavaScript CLI task and a test-repair task with preserved tests and actual passing
commands. Muse has independently completed a CLI and a fresh repair task; its
original repair failure remains recorded.
Neither candidate is qualified for slow use. A build or synthetic test does not establish coding reliability.
The evidence directory is `.cache/coding-reliability`; failed attempts are retained.

## Matched slow benchmark: terminal with incomplete coverage (16 October)

The single serial coordinator finished at **20:27:10.364 UTC**, with actual exit
code **1**. It used the unchanged `local-coding-slow-system-v1` protocol, a fresh
4B reference, then Qwen Q3 and Muse Q3, each scheduled for 36 one-hour cases and
39 phase-task rows. Its `completed` status means orchestration ended. Actual
coverage was **80/108 cases and 86/117 phases**; Muse left **28 cases and 31 phases
unrun**. Unrun cases are not additional failed attempts or passes.

| Cohort | Cases / planned | Phases / planned | Passed cases | Completed coding tasks | Disposition |
| --- | ---: | ---: | ---: | ---: | --- |
| [Fresh 4B reference](../.cache/coding-reliability/final-matched-slow-882-reference-terminal-snapshot-v1/report.json) | 36 / 36 | 39 / 39 | 12 | 8 | Complete measured reference; unqualified |
| [Qwen Q3 candidate](../.cache/coding-reliability/final-matched-slow-882-qwen-terminal-snapshot-v1/report.json) | 36 / 36 | 39 / 39 | 26 | 22 | Complete measured failure; ineligible and unqualified |
| [Muse Q3 candidate](../.cache/coding-reliability/final-matched-slow-882-muse-terminal-snapshot-v1/report.json) | 8 / 36 | 8 / 39 | 4 | 4 | Incomplete guard-stopped failure; ineligible and unqualified |

All three summaries retain zero false verifications and zero replay. Mandatory
criteria failed. Qwen's 26/36 and 38.89 percentage-point improvement over this
fresh 12/36 reference do not meet the unchanged minimum of 31/36 plus mandatory
criteria. Muse has no complete-run pass fraction or improvement; its partial
result cannot establish reliability. Case passes, phase passes, verification
passes and completed tasks remain separate. No aggregate quality rate is formed
across these models or the earlier diagnostic cohorts.

Muse's final no-op repeat 2 failed after **848,034 ms**; task
`bfbe46ee-0bc9-47ba-8200-63989c3e6c26` was **blocked/incomplete** after
**848,033 ms**, despite PASSED verification and all five independent checks
passing. At **20:27:08.776 UTC**, the retained `normal-pressure` guard recorded
host pressure **warning**, available memory **7,226,638,336 bytes (6.730 GiB)**
above its 1 GiB minimum, RSS **6,119,702,528 bytes**, and physical footprint
**1,034,005,736 bytes**. The pressure requirement independently failed;
`memoryGuardStopped` and `runtimeStopped` are true. These observations do not
establish native OOM, a native fault, observer causation or continuous memory
stability, and do not justify relaxing the guard. Host memory includes all
workloads. The last completed Muse task is no-op repeat 1.

Muse's three exact-LF cases passed and completed. Unicode/CRLF repeat 1 remained
incomplete/end_turn/UNVERIFIED with a null error despite all three independent
checks passing. Repeats 2 and 3 were blocked after two identical edits failed
against unchanged content; their behavior and readback checks failed. The
original outcomes are preserved without repair, rerun or budget extension.
The raw Muse reason says “Slow reference must contain all 36 cases and 39 unique
phases.” This is a reporting caveat: the actual reference is complete; Muse's
candidate is incomplete. Its original report remains unchanged.

The independent [Muse and coordinator review](../.cache/coding-reliability/final-matched-slow-882-muse-terminal-audit-v1/FINAL-REVIEW.txt)
found no material recorded-outcome/accounting inconsistency. It preserves all
eight frozen briefs, four approved changed effects, 24 fulfilled cleanup entries,
and three joined V2 exact-LF native receipts/provider pairs/host reports published
before Verify. Those joins are bounded recorded evidence; final upstream
HTTP/token wire, private finalization tokens and model attention were not
independently retained. Ordinary readbacks are separate from this V2 proof.
Previously completed [reference](../.cache/coding-reliability/final-matched-slow-882-reference-terminal-audit-v1/FINAL-REVIEW.txt)
and [Qwen](../.cache/coding-reliability/final-matched-slow-882-qwen-terminal-audit-v1/FINAL-REVIEW.txt)
audits preserve their failures and status distinctions. All three event streams
are closed; no terminal worker or consumed exec is polled or restarted.

After positive owned coordinator/controller/native cleanup, the independent
[current-byte binding review](../.cache/coding-reliability/final-matched-slow-882-whole-terminal-binding-audit-v1/FINAL-REVIEW.txt)
matched all **87 source entries and 592 selected resources**, 679 files totaling
219,649,524 bytes, with zero differences, errors or post-hash changes. All three
retained run bindings match. This selected resource scope differs from the 80B
87/624 inventory; no aggregate slow-binding digest is invented. Source, fixtures,
native computation, resources, profiles and packages stayed frozen through the
pipeline and final audit. This documentation-only update follows those audits;
`docs/` is outside that selected inventory and changes no inference bytes.

The immutable [coordinator snapshot](../.cache/coding-reliability/final-matched-slow-882-whole-terminal-snapshot-v1/pipeline.json)
is 149,716 bytes, SHA-256
`292ef33c5ea1cb800fe9b3c4f6e571bc973774277b642aaa259559e59732b18e`.
The Muse snapshot is 353,707 bytes, SHA-256
`678b9e8f91c45c1a7401a6bf891d162cb83ce2e0f789f096114df418e7585e06`.
The real coordinator exit was consumed once; all three real child exits are 1.
Owned model workers are absent. The checked 882 app and Desktop shortcut remain
available; locked interactive GUI behavior remains unverified. The required
108-case/117-phase measurement has not been achieved. The existing-only
authorization permits no restart, manual candidate, partial resume, guard
relaxation or budget extension. The same heartbeat and owned awake helper stay
active while required work remains incomplete. No general reliability or cloud
equivalence follows from these results.

Earlier evidence snapshot, 15 October 2026 after the 18:10 UTC CLI result and 18:33 UTC checked 882 package:
the requested Qwen/Muse models retain 36 terminal attempts, 26 cases and nine
completed independently passed tasks (five Qwen, four Muse). These attempts span
different packages, profiles and budgets; they are not a pooled qualification score.

| Selected diagnostic cohort | Actual result | Active case time |
| --- | --- | --- |
| [Qwen Q3, checked 729 package](../.cache/coding-reliability/runs/9bbf0f6f-bc80-488a-b71c-fcde3323a0bc/report.json) | Repair and CLI both completed; 2/2 passed | 36.22 / 29.37 min |
| [Muse Q3, checked 729 package](../.cache/coding-reliability/runs/c9ab48d6-d703-4ea1-bbe7-3327ca63bb82/report.json) | Repair blocked before edits; CLI completed; 1/2 passed | 21.24 / 27.80 min |
| [Muse Q3, checked 746 package](../.cache/coding-reliability/runs/b0ce0081-97c3-4430-96f0-147eb61c550a/report.json) | Repair and CLI both completed; 2/2 passed | 40.50 / 27.94 min |
| [Qwen Q3, checked 866 package](../.cache/coding-reliability/runs/2084135c-d733-4ba1-94bc-a669a2077cba/report.json) | Exact-file task blocked during planning; 0/1 passed, no execution | 11.44 min |
| [Qwen Q3, checked 870 package](../.cache/coding-reliability/runs/669ed20b-daac-4538-b0af-feb5a773e534/report.json) | Exact-file task completed; 1/1 passed; scoped evidence reviewed | 13.49 min |
| [Muse Q3, checked 870 package](../.cache/coding-reliability/runs/1cab81bf-7a95-4f3c-adbb-7492f08865da/report.json) | Exact-file task completed; 1/1 passed; scoped review limits retained | 13.51 min |

The separate first full 80B SSD coding diagnostic finished **0/2 passed**: its
exact-file task timed out at one hour with a missing final LF; its CLI task was
blocked before coding by the strict profile guard after fresh preparation changed
memory-admission budget fields. Cleanup completed. This is separate from the
requested-model cohorts and the earlier two-layer numerical proof described below.
The subsequent four-hour 80B exact-file diagnostic also ended **0/1 passed**: the
frozen requirement stayed 27 bytes including LF, while the final file remained
26 bytes without LF after three automatic Repair transitions. Its source/profile
binding stayed stable and owned cleanup completed. A separate four-hour CLI
diagnostic later failed before coding on host context admission; its result and
the following default-page change are recorded below. The distinct fresh 879-source
CLI trial later also ended **0/1 passed**: it wrote code and ran the approved check,
but remained blocked after the next context-admission failure. Its verification
and all recorded check groups passed; the agent task did not complete. The matched
slow benchmark was still pending at that snapshot; its terminal result is above.
These selected cohorts do not establish broad
coding quality or general stability. The separate source-only
877-check 80B exact-file trial completed **1/1 passed** in 181.7561 active minutes,
with exact bytes, actual readback and durable report evidence. The completed
independent review found no scoped acceptance blocker. This separate selected
pass does not change the requested Qwen/Muse totals or relabel either 80B failure.
Those selected diagnostics did not establish full qualification or matched slow reliability.

The checked 866 build introduced the reviewed version-2 readback controller and
explicit four-hour SSD diagnostic. Its rebuilt research sidecar, 147 research
tests, TypeScript, 866 app tests, native verification, offline package and smoke
passed. The ZIP is now preserved at
[the c128 archive](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-c12884302485.zip),
SHA-256 `c128843024850871553c90f66d54b71755323c996b91d1daffa9d791938e7e12`.
That archived build predates the current prompt-repair package described next.
The fresh Qwen pilot on 866 blocked after three preparation generations and no
execution. Its final retained schema error is described below; the first two raw
helper responses were not retained. This is not a generated-code quality result.

A narrow prompt-only repair is applied. Before the later long-goal amendment it
passed 86 focused checks, TypeScript and 869 full app checks. The tiny amendment
bounds only the example goal while retaining the complete original user request;
that cohort passed TypeScript and all 870 Node checks. Its offline package built
successfully: 229,608,601 bytes, SHA-256
`1404f8e66f74f680872d1cb7c4366fc1b84ceea92fdefaf1f5af1d8ab07a21f9`.
Packaged smoke passed; the app used for those pilots (PID 45151) was reopened through the
working Desktop shortcut. Fresh Qwen and Muse exact-file trials each completed
1/1 and their scoped evidence was reviewed. The separate 80B four-hour exact-file
trial failed 0/1; a later fresh trial on the 877-check source completed 1/1, as
recorded below. The next CLI diagnostic failed before coding on host context
admission. The fresh 879-source CLI trial after the limited paging change later
ran its approved check successfully, then remained blocked; its separate result
follows below. A reviewed
generic exact-file diagnostic change was applied to working source after the
earlier exact-file failure: 51 focused checks, all 877 Node checks, TypeScript and resource
verification passed. The subsequent 877-check offline package and smoke also
passed; its exact artifact identity and delivery are recorded below. The 870 ZIP
above predates this diagnostic change. The later scoped 80B repair completion
does not measure a controlled benefit from the changed feedback. After the CLI
context failure, the separate default-text-page change passed 154 Python and
879 Node checks (zero skips), TypeScript, native verification and two actual
Goose/rebuilt-sidecar integration tests. The sidecar was rebuilt once. The earlier
checked 879 offline package and smoke passed: 229,536,533 bytes, SHA-256
`be0f01f5c396118cfcce4171e6e8b2f06fff302e524f19142f43d2257a4f31c6`.
Its app (PID 33889) was reopened and the Desktop shortcut verified. These tests
and smoke alone did not establish native task completion. The subsequent real
879-source CLI reached an actual post-compaction verification call, then failed
before final model completion; no CLI task pass is recorded. A later lossless
host recovery-pointer change passed 46 focused checks, final TypeScript and
882 Node checks (zero skips), followed by offline package and smoke. Its current
ZIP is 229,537,076 bytes, SHA-256
`c8e37a05bc71feddf8b7e98cd1d1d7450df8a517ffa4524339b8dfb860feee64`.
The checked app (PID 63329) was reopened and the Desktop shortcut verified.
The subsequent native CLI trial on this pointer change failed on context
admission, as recorded below; software and package checks establish neither
native fit nor agent completion.
Strict schema/parser, three preparation attempts, manual-review
boundaries, fixtures/oracles, native computation and historical results are
unchanged. Locked GUI interaction remains unverified.

The incomplete historical repair remains incomplete despite correct code;
no result was relabeled. The current repair supplied command checks only one
positive example; its broader independent behavior check passed separately.
Historical raw scoring retains one false verification from an interrupted Qwen
task; no action replay was recorded. Attempts span different profiles and budgets
and must not be pooled into a qualification score. The generated
[offline comparison report](../.cache/coding-reliability/local-model-benchmark-report.html)
and [machine-readable evidence](../.cache/coding-reliability/local-model-benchmark-report.json)
preserve the exact cohorts, task checks, failures, artifact pins and source paths.

## Pinned models and execution

| Model | Public artifact | Revision | Bytes |
| --- | --- | --- | ---: |
| Qwen3.8 27B Q4_K_M | [LM Studio community GGUF](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF) | `5a7da681f60570ab5b439a587e912d2e5eddb582` | 16,810,714,336 |
| Muse Glimmer 30B Q4_K_M | [Meta GGUF](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF) | `43c7eadd41352a299ea8e0a36b3157978dd63596` | 16,756,683,904 |
| Qwen3.8 27B Q3_K_M | [Bartowski GGUF](https://huggingface.co/bartowski/Qwen3.8-27B-GGUF) | `87410e7b9a5c21e6ca70c0c9cc5237de909fe621` | 13,404,051,168 |
| Muse Glimmer 30B Q3_K_M | [Bartowski GGUF](https://huggingface.co/bartowski/Muse-Glimmer-30B-GGUF) | `01e1b7c30e19e1823ee9a73dec51d12f59ec4857` | 13,962,519,328 |
| Qwen3-Coder-Next 80B Q4_K_M, four shards | [Official Qwen GGUF](https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF) | `b82fb7382639d97b38fa7672e526c760c2fb358e` | 48,410,992,032 |

The catalog contains exact filenames and publisher SHA-256 values. Full-file
hashing and GGUF architecture checks precede loading. Imported files can match
these pins; files with other hashes retain their imported-model identity.

The requested 27B/30B models load alone on Metal with one slot. For the original Q4 IDs, Automatic mode at most 24 GiB RAM starts with
16,384 context tokens, 4,096 combined output tokens, batch 64/microbatch 16,
F16 K/V cache and enabled flash attention. Larger machines start with
32,768/8,192 output/128/32, then 16K F16. A native admission or allocation failure
may try 16K Q8_0 K/V. Explicit Low memory starts only 16K Q8_0 with the same
4,096 output, 64/16 batch limits and flash attention, plus supported partial CPU
placement. Qwen requests 64 GPU layers: two active blocks and its output/head norm
move to CPU, accounting for the skipped MTP slot in the native chooser. Muse
requests all chooser layers but overrides blocks 0, 1 and 10–13 to CPU: these are
its physically first six blocks in
lexicographic GGUF tensor order.
Its output remains on GPU, with native KV/workspace placement included in the
actual plan. Both disable weight repacking and use
four CPU decode/batch threads. The explicit profile binds `metalResidency: 'disabled'`
and injects `GGML_METAL_NO_RESIDENCY=1` after sanitizing the native planner/server
environment. Arbitrary inherited GGML variables remain stripped. This supported
engine hook avoids residency sets and their default 180-second wiring heartbeat;
GPU commands may still make weights resident. Accounting, OS reserve, pressure
and headroom guards do not change. Execution may be slower. No higher-memory fallback
is allowed. This separately selected profile does not retry a pressure failure.
Memory-pressure, telemetry, integrity and transport failures stop without replay. Output includes reasoning, tool arguments and the answer.
These 27B/30B profiles do not substitute CPU-only, 4K context or SSD-expert execution. Exact context and
native initialization K/V/flash-attention evidence must match the selected
profile. Mixed placement also requires the pinned layer-count log, four CPU
threads and CPU/Metal mapped-buffer sizes matching the verified header's actual
min/max tensor positions within log-rounding tolerance. A requested GPU layer
count alone cannot prove tensor placement; packed or unexplained buffers fail.
The candidate also requires exact startup `use residency sets = false`; missing,
enabled, malformed or contradictory evidence blocks all Chat/tool probes.

The Q3 IDs start with the explicit 16K Q8 candidate in both Automatic and Low
memory modes. Qwen moves the first 24 active blocks plus the output head and norm to CPU
with chooser42. Muse derives the physically first 20 complete blocks from its fully verified tensor layout;
the output head and norm move to CPU only when they precede the remaining GPU
span. Input embeddings stay on CPU even when their tensors follow the GPU
blocks. CPU and GPU mmap views may overlap; physical weights count once.
The lower-precision weights save 3.173 GiB for Qwen and 2.602 GiB for Muse.
This does not establish task quality or readiness. Each file must pass its own
SHA, architecture, native-template, allocation, resource and Chat/tool checks.
Both Q3 profiles use batch128/microbatch32 and require exact native startup
scalar evidence for one sequence, 16K context, and those batch limits. Header
geometry records Qwen Metal7,010,474,240/CPU6,143,598,336 bytes and Muse
Metal7,519,076,352/CPU6,430,328,832 bytes. Fresh native calibration and coding
tests are still required; the Q4 profiles remain unchanged.

The historical ten-block Muse Q3 source moved four more complete blocks than its
earlier six-block pilot. The ten-block diagnostic independently confirmed exact
startup, allocation and fixed Chat/tool checks. Its native plan records
9,847,062,528 bytes of Metal mmap span and 4,102,342,656 bytes of host span,
a 0.865 GiB Metal-span reduction. The conservative full-artifact working bound
remains 15,263,802,144 bytes (14.216 GiB). This does not establish coding task
completion or qualification.
The original Q4 Muse six-block placement remains unchanged.

The former whole-working-memory GPU comparison incorrectly mixed total RAM use
with Metal's recommended working-set size (17.759 GiB on this M5). The runtime
now requires a complete pinned SHA/metadata check and the integrity-covered
b11429 metadata-only allocation planner. Native host/Metal context and compute
rows are rounded up from MiB. The full artifact conservatively bounds mmap
weight spans, including Qwen's embedding gap and skipped MTP tensors. Unified
weights count once, with all native context/compute plus 1 GiB process headroom.
GPU spans/context/compute have an additional 256 MiB recommendation margin.
The OS capacity reserve stays `max(3 GiB, 20% of RAM)`, or 4.8 GiB on this Mac.
Plan identity binds model/template hashes, the complete verified engine file
inventory, planner hash, exact profile/precision and allocation rows. Mixed
profiles also bind CPU/GPU settings and header-derived mapped spans. The GPU
admission bound remains the full artifact, and overlapping virtual mappings are
not counted as extra physical weight copies.

Cold mapped-weight calibration requires normal pressure and current reclaimable
memory for nonmapped workspace plus the OS reserve; it does not require the
entire mapped artifact to be free RAM or count active anonymous app memory as
free. Free plus file-backed/purgeable cache is estimated without speculative-page
double counting. Owned-PID RSS and native physical footprint are sampled every
250 ms during loading/probes, every two seconds after readiness, and before
generation. Their maximum is bounded by the native working plan and RAM minus
OS reserve; pressure warnings, less than 1 GiB retained headroom, changed files
or unavailable/stale measurements stop only the owned model. These are sampled
protections, not an instantaneous OS allocation guarantee.

Partial-header no-allocation plans provisionally show why a 16K trial may fit
both capacity and the GPU recommendation. They do not establish that either
complete model loads, stays within resources or performs real coding tasks.
All four complete pinned artifacts are now downloaded and SHA-verified; exact native
profiles/probes and separate coding qualification remain required before any
readiness or default-adoption claim. The measured Qwen16K F16 attempt in
`.cache/coding-reliability/runs/3d34f240-f05f-4c35-b94d-c9e26d52149b` stopped at
2026-10-14T11:53:23.888Z solely on warning pressure, despite 1.064 GiB available
(1 GiB minimum), 4.174 GiB RSS and 1.336 GiB footprint below the 17.887 GiB bound.
It ran zero cases and confirmed owned-process cleanup. Later all-Metal Q8 trials
also stopped on warning pressure before task execution: Qwen run
`d7c33a8d-aea9-44cd-8aea-70afdbef58ad` had 1.339 GiB available, 3.068 GiB RSS and
0.128 GiB footprint; Muse run `f11eaa82-4789-4788-80d3-03099463682b` had 1.174 GiB
available, 2.451 GiB RSS and 0.146 GiB footprint. Their owned engines stopped.
The earlier mixed placements also stopped on warning pressure after their Q8
caches allocated: Qwen run `1a68fa54-97bd-4ea7-bd1e-9bb07b0f3654` had 1.645 GiB
available, 2.078 GiB RSS and 0.832 GiB footprint below its 17.448 GiB bound; the
Muse run `eb83753c-532f-4075-a518-a698ba8f3da0` had 2.513 GiB available, 5.570 GiB RSS and 0.336 GiB footprint below
its 16.800 GiB bound. Neither reached coding actions. The fourteen-block Qwen
attempt `185e067c-a093-4777-b6f5-036d3d7caa0b` also stopped solely on warning
pressure, with 3.688 GiB estimated reclaimable memory, 7.690 GiB RSS and 0.835 GiB
footprint below its 17.448 GiB bound. Its exact placement/Q8/FA settings matched.
The twenty-four-block CPU placements removed a further 2.082 GiB of Qwen and
2.666 GiB of Muse Metal mmap span relative to fourteen blocks. In Qwen run
`e046f2d4-9ea4-4a50-981b-1022352d224c`, an independent 90-second VM trace had
860 samples, no pressure warning and no observer errors; wired/compressor peaks
were 11.931/4.958 GiB. Its exact startup settings matched. Fixed checks nevertheless
exhausted the shared five-minute deadline, with prompt processing around 2.5
tokens/s; no coding case ran and cleanup completed. That historical Q4 explicit
no-residency candidate restored the earlier smaller CPU placements and required
new native calibration and coding qualification. The current Q3 placements are
specified separately above. Full-artifact no-allocation
comparisons establish neither readiness nor task quality. The pinned mmap loader advises
prefetching the whole GGUF and exposes no macOS no-prefetch flag. The kernel's
pressure signal has different working-set/compressor semantics from the app's
reclaimable file-cache estimate, so several GiB of that estimate cannot override
a warning ([Apple XNU pressure documentation](https://github.com/apple-oss-distributions/xnu/blob/main/doc/vm/memorystatus_notify.md)).

Qwen coding uses its native thinking template, preserved thinking history, and
medium or xhigh effort. Helpers use low effort without thinking. Muse preserves
its native reasoning and uses high coding/low helper strength; its thinking cannot
be disabled. Muse helpers receive the profile's full output allowance to avoid
consuming a short answer budget entirely in reasoning. Native Muse reasoning
has no separately enforced reasoning-token limit in this pinned engine; the
combined output limit and active task deadline remain enforced.

## Completion and local tools

Preparation receives a separate 24-generation allowance; execution receives 40,
and final evidence-based closing has one reserved generation. The inference
gateway owns compaction. Goose's second summarization/compaction path is disabled.
Canonical messages preserve roles, reasoning, call IDs, arguments, and tool
results under the verified model/template binding. Interrupted action exchanges
are excluded from future seeds; old pending calls are not reissued. Retained
host receipts are supplied as historical evidence with instructions not to repeat
actions. New model-proposed actions still require the normal approvals.

Coding turns with file reading enabled reduce descriptions for app-owned tools
without changing their names, argument schemas, or approvals. When context fills,
older closed exchanges can move into exact private JSONL recovery parts. The
current request and pending/latest exchanges remain in context. A compact pointer
marks the archive as historical data and incomplete as a summary; the model can
read the immutable parts with bounded continuation. Closed effects require
independent current-turn host receipts before this compaction. Unmatched historical
effects remain exact rather than acquiring authority from saved prose.

Recovery uses exact read-only file grants, including hash-checked populated parts
from the same session's prior turns. No archive-directory grant is provided.
Each turn retains at most 8 MiB, 40 parts, and 512 exchanges without eviction.
The existing 100-file total grant cap includes attachments and guidance; exceeding
it stops preparation before project actions rather than dropping required history.

Before project actions, the model extracts a frozen task brief. The host verifies
exact bytes and literal predicates with independent current file reads. A test
criterion passes only for the exact approved command and criterion IDs, a host
exit-zero receipt, and unchanged declared source/test hashes before, after, and
at final verification. Ordinary writes and implementation commands are separate
operation evidence. Later edits invalidate stale test results.

An ordinary model ending with missing checks triggers at most three verification
or repair continuations through the same live backend. Denial, cancellation,
truncation, and backend errors do not authorize a restart. Semantic requirements
without mechanical proof remain unverified. The UI exposes the frozen plan;
passing its checks does not prove the model included every user requirement.

The host preserves explicitly requested verification commands byte-for-byte when
the human request uses `run exactly` followed by a whole command in backticks or
quotes, or bare `run exactly COMMAND to verify ...`. It binds ordinary Node/Python
script inputs to the command receipt. For explicit `Preserve/Keep SCRIPT unchanged`
or same-clause `Read SCRIPT and preserve it unchanged`, it captures the existing
script's digest before actions and independently compares it at completion. A
changed protected script stops the task. These bounded grammars do not interpret
arbitrary prose, shell semantics, the quality of assertions, or complete coverage.

The applied version-2 task brief supports bounded explicit `readback_file`
criteria linked to the exact user-provided `exact_file` bytes. The receipt wire
protocol is separately named `local-agent-readback-v1`. Routine agent reading and
reporting cannot become a permanently unverified manual criterion or be silently
omitted; genuine human/subjective review stays manual. Unsupported or ambiguous
explicit readback requests stop preparation before effects. The current grammar
supports one unambiguous literal UTF-8 target, not arbitrary natural language.

This evidence requires the ordinary authorized Python `Grants.read_file` call,
not a replacement host read. A private loopback begin/finish witness binds the
pre-read revision and complete native result. The exact tool call/result must
then reach the final local inference request through Goose and the gateway,
including compaction, and complete normally. A nonce, successful file operation,
model claim or independent byte comparison alone is insufficient.

After normal completion, the host publishes an escaped exact-content report from
validated delivered evidence and awaits durable storage before committing its
acceptance receipt. Final byte/revision checks and the owned-runtime health latch
remain active through action/backend/gateway drain. A one-use healthy intentional
cleanup token cannot revive cancelled, failed or stale evidence. The final
`verify_readback_file` acceptance row must survive those checks. The harness saves
`task.readbackReports` and `host-readback-report` events; the app saves its chat and
canonical transcript before emitting the visible report. Scoped Qwen/Muse 870
completions and the later source-only 80B 877 completion are recorded below. The
saved native result/next-request pair, normal completion, live gates and durable
report support those scoped outcomes; no separate saved final HTTP wire or
private finalization-token trace is claimed. The
[post-readback execution recipe](../.cache/coding-reliability/EXECUTION-RECIPE-POST-READBACK.txt)
records the exact local artifacts, commands and evidence checks. Its original
stale-sidecar finding was resolved by the subsequent rebuild; a TypeScript build
alone would not include the new Python module.

Blocked, incomplete, cancelled, and timed-out coding tasks receive a deterministic
closing summary from host checks and receipts, without another model generation.
Acceptance counts remain separate from successful reads, writes, and commands.
Adding that summary cannot promote an incomplete task to completed.

For these two models research tools are disabled for each turn. Approved commands
on macOS run through a host-owned network sandbox permitting only loopback.
Unavailable enforcement fails closed. All ordinary file/command approvals remain
in effect. The benchmark grants only its isolated fixture actions automatically;
these grants do not alter app approval policy.
Local-only command environments omit inherited proxy forwarding settings. The
socket policy still permits local services; it does not certify what an independently
configured loopback service might do beyond the child process's network sandbox.

The one-off pinned downloader uses at most 16 range workers, approved public
HTTPS hosts, HTTP/2 receive windows bounded to 4 MiB per stream and 16 MiB per
connection, and 8 MiB requests within 32 MiB resumable disk chunks. An exclusive
task-local lock prevents concurrent writers. Full SHA-256 and GGUF architecture
verification precede atomic publication of each final filename. HTTP/2 does not
forward credentials or inherited proxy settings; public acquisition is separate
from loopback-only inference and sandboxed task commands.

## Qualification criteria

The native runner uses the production task controller, inference gateway, Goose
binary, reviewed actions, and runtime. Twelve fixtures run three times per model.
Trusted verification outside the model's writable workspace checks actual behavior
and hashes the original test scaffold to catch weakened tests.

Promotion requires at least 31 of 36 completed attempts, a completion improvement
of at least 20 percentage points over the original 4B baseline, every exact-file,
no-op, and denial/cancellation case, zero false verified outcomes, and zero replay.
Results record weights, template, engine, profile, timing, resources, and failures.
Partial case selections or fewer repeats are diagnostic runs, not qualification.

A separate `local-coding-slow-system-v1` protocol now permits one hour per case
for all 12 fixtures repeated three times: 36 cases and 39 task phases. It first
requires a fresh complete 4B reference from the current production controller,
with the same source, resource, fixture and machine byte bindings. A candidate
must still pass at least 31/36 cases, every mandatory exact-file/no-op/safety
case, all command receipts and preserved tests, zero false verification/replay,
normal memory guards and complete owned cleanup, and improve by at least 20
percentage points over that matched reference. Exact-file and no-op phases also
require complete byte-exact native tool readback after the last file effect.
Preparation/execution allowances remain 24/40 generations with careful effort.
The separate `slowReliability.eligibleForSlowUse` outcome never changes the
original 15-minute `qualified` result. Selected one-hour diagnostics, historical
runs and the original 4B 12/36 baseline cannot substitute for this full protocol.
No complete slow-protocol eligibility result is recorded in this snapshot.

The applied `ssd-selected-4h-v1` route is a distinct, explicit source-only
selected diagnostic: exact `qwen3-coder-next:80b`, explicit `--memory-mode
ssd-experts`, known unique `--cases`, `--repeat 1`, current source, and no package,
preserved snapshot or baseline. Each selected case gets four hours. It cannot
qualify, promote or establish slow-profile eligibility; it never extends a saved
one-hour run. The default 15-minute benchmark, ordinary desktop one-hour budget,
matched slow one-hour protocol, fixtures, independent oracles and step caps stay
unchanged. This opt-in is not available for the requested 27B/30B models.

Its distinct protocol binds current source/resources, the exact artifact/template,
native computation profile and scoped certificate, fresh trial/native ownership
and actual normal-pressure memory measurements. The binding is compared again
after owned cleanup. A host clock change does not establish four-hour stability
or broaden the numerical certificate: exact native/profile/certificate validation
and new real runs are still required. Any computation/resource change needs its
corresponding fresh validation. The first four-hour exact-file run finished 0/1
with stable source/profile binding; a later fresh run on the 877-check source
completed 1/1 with actual repaired bytes and linked readback evidence. Their
separate terminal results and completed independent binding/evidence review are
recorded below. The subsequent CLI diagnostic failed before coding on host
context admission. The later 879-source CLI after the default-page change ran
the approved command and passed its bounded checks, but ended blocked before
final model completion. None establishes general four-hour stability or qualification.

Package smoke checks and an actual native app coding task are separate requirements.
The script explicitly records `nativeUIVerified: false`; it cannot certify the GUI.

## Recorded evidence and current limits

The dated snapshots below retain their original intermediate observations.
Pending or active wording in a historical snapshot does not override the current
summary and later terminal reports. Failed runs and incomplete tasks stay failed
or incomplete after software fixes.

The original 4B run completed all 36 cases and passed 12. Revalidation with stronger
behavioral assertions and saved host receipts left that score at 12/36. The raw run
and all failed workspaces remain in `.cache/coding-reliability/runs`; the promotion
baseline is `.cache/coding-reliability/baseline-revalidated.json`. It records the
original source snapshot and model digest. The benchmark uses the current isolated
host and a 40-generation allowance, so it is not a comparison of weights alone.

The packaged app's native 4B CLI diagnostic exposed a real failure: the generated
program referenced a block-scoped variable outside its scope, its valid-input
command exited 1, and the 8K context then exhausted. The host outcome remained
blocked. The model's closing prose falsely claimed unrun tests had passed; that
failure is retained in `native-ui/cli-failure-before-fix.json` and its screenshot.
The trusted five-case test file was unchanged and independently failed. This is
evidence against claiming that the old model now reliably completes coding tasks.

A second native repair request retained the exact `node ui-check.mjs` criterion
and independently verified the protected script's initial digest. The 4B model
again exhausted its 8K context before any edit or verification command. The rebuilt
app correctly closed with a blocked outcome, zero command receipts, and one
unverified command criterion; it did not invent test success. Evidence is in
`native-ui/cli-protected-test-honest-blocked.json` and its screenshot. That diagnostic
also exposed a swallowed fatal inference error appearing as ACP `end_turn`; the
shared controller now checks the inference's independent terminal state before
and after each backend prompt and prohibits repair continuation after such an
error. Neither diagnostic qualifies the requested larger models or establishes
reliable completion by the old 4B model.

After the user unlocked the Mac, the final packaged controller was tested again.
The exact verification command ran once and exited 1; both fixture files remained
unchanged. The saved error-paragraph count fell from four to one, and the final host
summary reported a blocked task with one failed command. This native diagnostic
confirms the fatal-error stopping fix, not successful coding repair. Its report is
`native-ui/cli-final-fatal-guard.json` with screenshot `cli-final-fatal-guard.png`.
The 4B model still exhausted context before making a repair.

The earlier waiting coordinator was cancelled before any model attempt, retaining
its terminal report at
`.cache/coding-reliability/qualification-pipeline-0a48f712-42eb-402a-a3e7-52550a8891c3.json`.
The original Q4 acquisition finished in
`.cache/coding-reliability/download-sequential.log`. The separate Q3 acquisition
started in `download-q3-sequential.log` and completed in
`download-q3-final-resume.log`, with bounded workers assigned to Qwen first.
Each final file is published only after full SHA/GGUF verification. The
downloader preserves the two existing verified Q4 records and filenames while
appending independently verified Q3 records. It does not start an engine.
The four records are retained in `downloads.json`; `completed-model-artifacts.json`
records the verified headers and template hashes. Both Q3 files are also installed
under `~/Library/Application Support/Local Agent/gguf-runtime/models` and staged
in the isolated GUI profile. `installed-q3-models.json` records their exact pins
and hardlink installation without changing personal state or the selected model.
The regular cache retains the existing Qwen3.5 files. Installation grants no
native readiness or task qualification, and no new default has been promoted.

The historical planner source passed type checking and 729/729 regression
tests (`check-planner-final.log`), including initial failing-check imperative
capture, scoped planner guidance and aligned verification-ID help. The previous
verification-ID source passed 719/719 (`check-frozen-verification-parity.log`),
including deadline parity and the real HTTP delayed-approval regression. The preceding packaged
action-path source passed 710/710 (`check-action-path-final.log`). Independent review confirmed workspace-contained
path canonicalization without relaxing approvals, protected paths or command
allowlists. The previous supplied-command/checkpoint source passed 704/704
(`check-supplied-command-final.log`), including validation that
the helper retains supplied verification commands without inventing additional
mandatory commands and accepts quoted command paths. The bounded checkpoint
source previously passed 700/700 (`check-qwen-q3-checkpoint-final.log`). The
preparation/slow-protocol source passed 696/696
(`check-preparation-slow-protocol-final.log`), including protected
file-name parsing, exact command-criterion repair, full slow-reference binding,
native readback and report counterexamples. The preceding CPU24/CPU20 source
passed 673/673 (`check-q3-cpu24-cpu20-desktop-budget.log`), including Q3 placement,
native batch attestation, one-hour diagnostic qualification exclusion, compact
preparation, delayed-header and transport-selection checks. The previous
compact-preparation source passed 665/665 (`check-compact-preparation.log`). The preceding transport change passed 661/661
tests (`check-harness-production-transport.log`). The ten-block Muse Q3 source previously passed
658/658 tests (`check-muse-q3-cpu10-localhost.log`); the earlier six-block packaged
source passed 657/657 (`check-q3-cache.log`). The implementation includes verified native
allocation planning, strict stream validation for all models, actual verification
receipt repair counting, and action draining before final file/evidence snapshots.
The immutable recovery path was also read through real packaged Goose/file tools,
including continuation after a newer part was written. Failed log lookups preserve
unchanged successful verification; failed mutations still invalidate it.

Two additional 4B native diagnostics remain unsuccessful coding tasks. The first
exposed metadata failures consuming repair cycles
(`native-ui/cli-context-recovery-metadata-failure.json`). After that fix the model
corrected its verification metadata without consuming extra repair cycles, but
made no implementation change and reached its 8K context limit after two real
failed tests (`native-ui/cli-metadata-fix-context-limit.json`). The original CLI
and protected test digests remained unchanged. Neither is requested-model quality
evidence or a successful repair.

The 866 readback package is preserved at
[Free-Local-Agent-0.5.0-alpha.1-mac-arm64-c12884302485.zip](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-c12884302485.zip),
SHA-256 `c128843024850871553c90f66d54b71755323c996b91d1daffa9d791938e7e12`,
229,606,132 bytes. It passed offline package/smoke and was reopened with the
working Desktop shortcut. It now predates the applied prompt-only repair. The newer 870-check source has
built and smoke-tested its package; both requested-model exact-file pilots later
completed on it. The later 877 exact-file diagnostic feedback change and 879
default-text-page change each passed their own offline package and smoke. Their
artifacts and fresh-model results are recorded separately below.

The earlier completed Muse repair/CLI diagnostic used the 746-test
build. Its preserved archive is
[Free-Local-Agent-0.5.0-alpha.1-mac-arm64-9eda1a53b29b.zip](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-9eda1a53b29b.zip),
SHA-256 `9eda1a53b29b20ffc8e70f4c050c1a20aee3f801d2aa04a8e55aa1245e8605f8`.
Its build/package/smoke checks passed (`build-command-scope-final.log`,
`package-command-scope-final.log`, `smoke-command-scope-final.log`). The app was
opened and the Desktop shortcut points to its bundle. Locked-desktop launch
alone supplies no interactive GUI coding proof. This 746 archive predates both
the checked 866 readback package and the newer prompt-only repair.

The historical 729 package is preserved separately at
[Free-Local-Agent-0.5.0-alpha.1-mac-arm64-a2cda6dca8aa.zip](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-a2cda6dca8aa.zip),
SHA-256 `a2cda6dca8aa196bfe38248ba5456d1a846d4a7fa50f1e781367b9bd3453f40c`,
with `build-planner-command-final.log`, `package-planner-final.log` and
`smoke-planner-final.log`. The previous 719-test ZIP is archived at
`.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-fd5b005edc7f.zip`,
SHA-256 `fd5b005edc7fbd783aad390c6c6d1ae52e9a4ce477e88f09976601271faa230b`.
The preceding action-path-710 ZIP hash is
`b6553a743fac62e758a231e6d5bc507909891407c206e4a110f7155be4299677`.
The preceding supplied-command-704 ZIP hash is
`5f59355bba2bdb48aacbdb465b589f747f9e476d78b1081eea35df1e64b9236d`.
Historical checkpoint-700 and preparation-696 ZIP hashes are
`3e5ad444248a99bd6ec613e97b0342ed84bf84a2166f2aea07b42c151a7b3a47`
and `481649fe05e2e2ec882e2e82412519d1fc75c867d07beaf8d3cd1675fa710034`;
their matching build/package/smoke logs retain those software results. The
preceding CPU24/CPU20 package hash
`9832dff17b139a8cd00c0f75bce862d0deda5d1444023fc347c3fe8e169ab5f5`
and its passed build, package and smoke checks remain historical evidence
(`build-q3-cpu24-cpu20.log`, `package-q3-cpu24-cpu20.log`,
`smoke-q3-cpu24-cpu20.log`). The earlier six-block ZIP's SHA-256
`3ecff695deb377a3c41604b13de6b3e65da63e5b2722f1345aa77a54f9c7bd05`
and its build/package/smoke logs (`build-q3-cache.log`, `package-q3-cache.log`,
`smoke-q3-cache.log`) remain historical evidence.
The historical `release/SHA256SUMS` entry is not a fresh-package receipt; the
next final build must publish its own actual archive/digest/smoke evidence.
`.cache/coding-reliability/implementation-status.json` records its checked digest,
validation and remaining model qualification work. A passing build, package smoke
check, or regression suite does not establish model task completion. Actual
model results are recorded separately below and in the generated report.

The first complete Qwen Q3 artifact passed native Chat/tool calibration using
16K Q8 and the mixed CPU/Metal placement. Two independent five-minute VM traces
contained 5,753 samples, zero pressure warnings and zero observer errors; the
smallest reclaimable estimate was 2.100 GiB. That is measured memory evidence,
not coding qualification. Run `25790e27-2853-4c7a-a3d4-45f85b1ee64d` wrote the
correct 27-byte `note.txt`, but was cancelled while processing the next request.
The model stopped before its next read/closing and did not complete the task.
The saved task was cancelled; the ledger's independent final file read passed
for the correct bytes. Root cancellation also aborted the separate behavioral
oracle before it finished, and the conservative raw scoring counted one false
verification. That raw count and zero passed cases remain retained unchanged;
this diagnostic remains unqualified. Per-request prompt caching had been disabled,
forcing a full approximately 4K prompt after every tool. The later separately
bound cache-reuse profile retained zero extra RAM prompt cache and zero recurrent
checkpoints; it is historical relative to the bounded-checkpoint trial below.
Only coding generations from the exact Q3 IDs with the bound
`codingPromptCache: true` policy request reuse of the existing single slot.
Helpers, finalization, probes, Q4 and older models stay uncached. This changes
the Q3 profile signature, so earlier memory/task proof is not inherited. The
native engine compares the exact rendered token prefix and resets safely when
it cannot restore the required recurrent state. A setting alone does not prove
reuse or improved completion.

The current exact Qwen Q3 CPU24 profile additionally permits one recurrent
checkpoint with minimum spacing 8192 and explicitly reserves 320 MiB of host
workspace. Its verified layout bounds serialized state at 156,894,364 bytes
(149.626 MiB) and accounts conservatively for two simultaneous serialized buffers.
The native planner's device rows stay unchanged; the additional host reserve is
included in the profile signature, memory-plan digest, working/resident bounds
and cold admission. The existing OS reserve, normal-pressure/headroom guards,
context, output, generation and safety limits remain unchanged. Other model
profiles retain their zero-checkpoint policy. This stores native inference state;
it does not restore the host task ledger, grants, test receipts or completed
actions. Creation, replacement and any restore are validated against the single
retained checkpoint's tuple; these are separate observations from task quality.

The cache-enabled Qwen retry `20e12bcc-93d3-44d2-bd6f-83a21f099cae` also passed
fixed native calibration, then stopped on warning pressure before any coding
action. At that earlier attempt a Gradle daemon was observed using about 6.7 GiB
RSS. It was left untouched; the user asked to keep Claude's build running.

The six-block Muse Q3 pilot `6c098ccd-c39a-4f57-a693-9e8cc0e49f11` reached its prepared
16K Q8 profile after exact startup, fixed Chat, tool-call and actual tool-result
continuation checks. Its own template hash is
`114f55ebdc1804c1af371197b9fdf2d6bb925966c9dfe46b73782a71bc07965e`.
The later task preparation stopped at 2026-10-14T15:24:15.493Z on warning
pressure: 3.589 GiB estimated reclaimable memory, 6.600 GiB owned RSS and
0.352 GiB physical footprint, below its 14.216 GiB working bound. No acceptance
plan, coding action or command receipt was produced. The host closed honestly
as blocked. The terminal report records one attempted diagnostic case, zero
passed cases, zero false verification/replay and confirmed owned-process cleanup.
It explicitly records `qualified: false` and `nativeUIVerified: false`.
Calibration checks are separate from completing real coding work.

The ten-block Muse Q3 diagnostic `45822dc4-6bee-48c8-aa4d-e2796c660964`
independently passed its exact startup and fixed Chat/tool calibration at
2026-10-14T15:39:34.106Z. Its first coding preparation failed after 301,473 ms
with `fetch failed`; it ended at 2026-10-14T15:44:36.727Z as blocked and
unverified with no acceptance plan, coding actions or command receipts. The
terminal report retains zero passed cases, zero false verification/replay,
`qualified: false`, `nativeUIVerified: false` and confirmed owned-process cleanup.
Its separate five-minute VM trace recorded 2,877 samples, normal pressure level
1 throughout, and zero observer errors. The minimum reclaimable estimate was
4,023,713,792 bytes (3.747 GiB), and peak wired memory was 13,211,926,528 bytes
(12.305 GiB); see `muse-q3-cpu10-memory-analysis.json`. No pressure stop or native
crash was reported. This trace covers five minutes, not an entire coding task.

The approximately five-minute fetch failure is consistent with the harness's
global fetch override bypassing the production loopback transport's longer
header allowance. This remains a transport diagnosis, not a passed coding case.
The updated harness now uses the production loopback transport instead of global
fetch. Its source-snapshot branch retains the original wrapper, preserving the
frozen baseline. The independent behavioral oracle and 15-minute task deadline
stay intact. Source helpers remain disabled, actual inference traffic stays on
loopback, and runtime memory/gateway flags are unchanged.
No completed coding result is inherited from either Muse calibration.

Memory and transport investigation remain active. Root's latest read found the earlier Gradle
PID 22143 absent; Codex did not stop it or change Claude's project/build work.
The new Muse pressure failure is therefore retained as evidence requiring its own
memory diagnosis, rather than attributed to that earlier daemon. Both full
36-case qualifications, successful native GUI coding tasks and any default
promotion remain outstanding. All earlier raw failures and original Q4 pins are
retained unchanged.
The separate ten-block `test-repair` diagnostic,
`c1c15599-6cd3-430b-a61a-e7a6e3e6d772`, used the corrected production transport
and independently passed startup/fixed Chat/tool calibration. It stopped at
2026-10-14T15:56:48.293Z on warning pressure after 60,117 ms of coding preparation:
3.558 GiB reclaimable estimate, 9.583 GiB owned RSS and 0.351 GiB footprint, below
the 14.216 GiB working bound. No acceptance plan, coding action or command receipt
was produced. The terminal report at 15:56:48.713Z records blocked/unverified,
zero passed cases, zero false verification/replay, and owned-process cleanup.
The previous five-minute normal-pressure trace does not establish memory safety
for this later run.

After that failure, further loads were held for a quiet shared-memory window.
Root's read-only process check at 2026-10-14T15:58:39Z found Android Studio PID
42751 at 3,516,688 KiB RSS, Java PID 42494 at 2,614,624 KiB and Java PID 42564 at
836,096 KiB: about 6.64 GiB combined RSS, plus about 0.96 GiB for Spotlight.
These observations explain the hold; summed RSS is not a distinct physical-RAM
measurement or proof that a particular app caused the warning. Other agents'
applications and Claude's build remain untouched. No batch, guard, deadline or
oracle was relaxed.

The user subsequently confirmed the quiet window was ready. Root's read-only
check at 2026-10-14T16:04:47Z found Android Studio absent, Java at 178,528 KiB
RSS, normal kernel pressure and about 8.79 GiB estimated available memory.
Root resumed the same ten-block Muse Q3 `test-repair` profile around
2026-10-14T16:06Z, label `muse-q3-cpu10-quiet-repair` (owned session 95089).
Its actual load attempt `275667a9-650d-4a3a-8adf-1af1f8f1c5a2` began at
16:09:14.602Z and failed during loading after about 23 seconds. Warning pressure
was reported at 16:09:36.581Z with 5.087 GiB estimated available memory,
3.670 GiB owned RSS and 0.338 GiB footprint. No task or calibration readiness
was reached; the terminal report records zero cases and confirmed owned cleanup.

Root then checked the remaining idle daemons beyond their small RSS readings.
Gradle PID 42494 used `-Xmx6g`, had zero CPU activity, and reported `3.1G` physical
footprint and `3G` swapped; Kotlin PID 42564 reported `841.8M` footprint.
The Gradle log last recorded idle at 15:59:08Z after the build finished. With the
user's quiet-window confirmation and targeted approval, root sent graceful
SIGTERM only to those exact idle IDs. Both were absent at 16:13:49Z. Claude's
active work, project and build configuration were not changed. Compressor
physical memory fell from about 5.04 to 2.56 GiB; root's fresh observation showed
normal pressure and about 11.85 GiB estimated available memory. These observations
are not a model-readiness guarantee.

Root started a fresh serial retry at 2026-10-14T16:14:20Z, label
`muse-q3-cpu10-daemons-stopped-repair` (owned session 11626). That attempt,
`21137b36-e59e-4b26-9bc0-dc306b5aa551`, passed its own fixed native calibration
but stopped at 16:20:18.821Z on warning pressure after 232,335 ms of task
preparation: 4.152 GiB available, 5.882 GiB owned RSS and 0.348 GiB footprint.
No brief, coding action or command was produced. Its terminal report at
16:20:19.346Z records blocked/unverified, zero passed cases, zero false
verification/replay and confirmed owned-process cleanup.

The user explicitly authorized quitting Chrome and Mattermost. Root performed
normal native-app quits through computer use; both succeeded. The 16:30:22Z
read-only process check found both apps and the previously stopped idle daemons
absent, normal pressure and about 1.558 GiB compressor physical memory. No signal
was sent to the Claude agent. This recovery is not coding-readiness evidence.
Root started one fresh serial retry at 2026-10-14T16:30:50Z, label
`muse-q3-cpu10-apps-quit-repair` (owned session 80578). That attempt,
`adf3a589-739a-432d-a968-158837de9cf1`, passed its native probes, then stopped
at 16:37:19.471Z on warning pressure after 274,361 ms of task preparation:
4.396 GiB available, 7.929 GiB owned RSS and 0.352 GiB footprint. No brief,
coding action or command was produced. Its terminal report at 16:37:20.151Z
records blocked/unverified, zero passed cases, zero false verification/replay
and confirmed owned-process cleanup.

At this historical 16:37 UTC snapshot, no model was active. Root investigated remaining system and driver memory
use through read-only observations. A same-user footprint census is permitted;
no additional applications are being closed. Compact preparation facts are now implemented for task-contract extraction.
Full coding guidance, its exact read-only snapshot, the human request and staged
source evidence remain intact; the source passed 665 tests and type checking.
The refreshed package passed its offline build and smoke checks; native token/speed benefit is unmeasured. All 21 terminal attempts
remain retained. Model profiles, transport, batch sizes, independent oracle,
guards and the 15-minute deadline are unchanged. Neither
model is qualified or promoted; both still require completed coding pilots,
full qualification and separate native GUI evidence.


A same-user memory census found replacement Gradle PID47479 and Kotlin PID47555
retaining about 4 GiB after the original idle-daemon cleanup. Their latest build
finished at 20:18:39 Tehran time. These replacement processes are untouched;
all further model loads await confirmation that every Claude session holds builds.
Compressed footprint and RSS differ, and summed process footprints do not equal
distinct physical RAM. No driver leak or memory-counter double count is established.


Compact preparation check/build/package/smoke logs are retained as
`check-compact-preparation.log`, `build-compact-preparation.log`,
`package-compact-preparation.log` and `smoke-compact-preparation.log`.
Previous package hashes remain in implementation-status.json as historical proof.
At that historical compact-preparation snapshot no requested-model coding case
had passed, and no qualification is inherited
from these software checks.


## Unattended slower diagnostics (14 October, 18:06 UTC)

`--budget-profile desktop-task --cases exact-lf,cli-inputs --repeat 1` gives each
selected case the normal desktop one-hour budget. It preserves every independent
behavioral oracle, protected-file check, exact test command, safety guard and
generation limit. Such diagnostics always have `qualified:false`, even when
all selected cases pass. The default benchmark remains 15 minutes and the full
36-case criteria and original baseline are unchanged.

The latest old-profile Qwen load (`709730ca-8c52-44c0-8402-6142658526ec`) stopped
at warning pressure with 2.903 GiB available before calibration or coding. This
followed targeted graceful shutdown of the verified idle Gradle 47479/Kotlin 47555
pair after build completion; no active Claude build or agent was stopped. All 22
terminal attempts at that historical snapshot remain retained; none had completed
a requested-model case then. Later results are recorded below.

The user authorized unattended work, including continuing terminal tests while
the Mac is locked. The rebuilt app was opened. GUI proof still requires an
unlocked desktop; terminal testing continues independently. The official free
Qwen3-Coder-Next 80B Q4 four-shard transfer began in the isolated large-model cache
and was initially paused at about 2.05 GB for serial native trials. Its 45.09 GiB weights need
fresh numerical and memory validation for bounded SSD inference; downloading
does not establish runtime readiness.

## First completed Qwen task and remaining failures (14 October, 19:15 UTC)

Run `84fe3d03-954d-4667-94d5-c5bb283d3960` used the Qwen Q3 CPU24/Metal profile
and the selected one-hour desktop diagnostic budget. The `exact-lf` task created
the required 27 UTF-8 bytes, then read the complete file back with its matching
SHA-256 and final LF. It closed as completed/passed after 1,085,956 ms (18.10
minutes). Its separate behavioral oracle passed, profile binding was verified,
and all three cleanup stages fulfilled. No command was requested or run. This is
a real file-tool completion; it is not a completed repository repair or evidence
of a full quality score.

The same run's `cli-inputs` phase blocked during preparation: a combined protected
file-name value was interpreted as a nested path, causing `ENOTDIR`, and a command
criterion was malformed. No implementation edit or verification command ran;
the independent behavioral and command-receipt checks failed. Its original
package/test scaffolds were unchanged, and cleanup completed. The final source
adds regression-covered repairs for these host failures, but a software test does
not establish that a later real model repair succeeds.

The [terminal report](../.cache/coding-reliability/runs/84fe3d03-954d-4667-94d5-c5bb283d3960/report.json)
records one passed and one failed case, zero false verification/replay for
this run, `qualified:false`, and `nativeUIVerified:false`. The two additional
packaged launch attempts at 19:15 UTC failed before loading: one could not stat
an ASAR-internal resource, and the next rejected the old baseline's changed CLI
fixture digest. Those reports are retained; neither reached a coding task.
No Muse pass or complete original/slow qualification is inferred from Qwen's
single exact-file result.

## Bounded checkpoint trial (14 October, 20:14 UTC)

The zero-checkpoint packaged run
`c709a397-5dd9-4aec-a254-746aab421f63` reused a 4,962-token prefix once, but its
next native request required a one-token rewind from 5,314 to 5,313 cached/common
tokens. Without recurrent state it explicitly reset to zero and reprocessed the
full prompt. It was canceled at 19:36:47 UTC with no edits, no passing CLI case,
unchanged protected scaffolds, zero false verification/replay and owned cleanup.
The exact differing token spelling was not recorded. This is measured reset
evidence, not a claim about which character caused it.

The checkpoint-enabled run
`497fb801-ade2-4f42-844c-ff88216a99a5` confirmed startup maximum one/spacing 8192
and real 149.626-MiB allocation/replacement during its unchanged fixed native
calibration. It later prepared extra mandatory commands beyond the supplied
criterion and was canceled before edits at 20:00:34 UTC. No checkpoint restore or
completed coding repair occurred. The 704-test source repairs that plan-validation
failure; those software checks do not turn the interrupted run into success.

Fresh run `84a951bf-0ae1-4ef5-85ea-ce7c3394eaba` started at 20:07:42 UTC on the
704-test packaged source with the new bound profile. Its measured calibration
at 20:10:36 UTC had normal pressure and 7,878,705,152 bytes (7.34 GiB) estimated
available memory. Native logs again prove 149.626-MiB checkpoint creation and
replacement. After the helper prepared valid supplied commands, the run entered
Implement at 20:13:41 UTC. At this 20:14 snapshot it is still processing the first
coding prompt: no terminal task, post-edit command receipt, independent repair
pass or native checkpoint restore has been recorded. The active attempt is not
counted as completed or as a clean terminal stop.

Saved reports and native events under those three run IDs preserve the separate
profile signatures and original evidence. The [checkpoint review](../.cache/coding-reliability/qwen-q3-checkpoint-review.md)
explains measured prefix reset, serialized memory accounting and the distinction
between proposed restoration benefit and actual observations. The selected
one-hour trials remain diagnostics; no full matched slow protocol is complete.

## Actual checkpoint restoration and path correction (14 October, 20:49 UTC)

The later native events from run `84a951bf-0ae1-4ef5-85ea-ce7c3394eaba` demonstrate
an actual coding-to-coding checkpoint restoration at 20:22:32.521 UTC. Task 614
restored the retained state at position 4,775 with 4,776 cached tokens for the
new 5,148-token prompt, leaving only 372 tokens to process. It retained the bound
149.626-MiB state without a full reset or guard error. Two further restorations
are logged at 20:23:59 and 20:25:47. This proves prefix reuse in that continuation;
it does not prove correct code or a completed task.

The model then proposed an absolute write path inside the correct fixture
workspace. The host denied the raw action metadata before executing it. The
original CLI program and protected test scaffolds stayed unchanged; no requested
verification command passed and the independent repair checks failed. The CLI
phase closed blocked, and the subsequent repair phase was canceled. The whole
run closed at 20:41:45 UTC with zero passed cases, zero false verification/replay
and confirmed owned cleanup. The 710-test package adds independently reviewed
workspace-contained action-path canonicalization, preserving approval and
protected-file boundaries. Its real model success is still unmeasured.

Fresh diagnostic `qwen-q3-canonical-path-packaged-real-code` started at 20:49:05
UTC using the current packaged controller for CLI inputs and test repair. Its
run directory is `c38dd81c-b702-4295-8616-014c511c6034`; at the initial report
snapshot no stable report JSON was available, so the generator lists it as
unavailable instead of inventing an active case or completion. The stable report
was subsequently published: calibration at 20:51:56 UTC had normal pressure,
7,581,007,872 bytes (7.06 GiB) available and measured fixed-probe decode of 4.73
tokens/s. The 20:52:52 snapshot records one active attempt and no terminal case
or completed task from it. Probe speed is not coding-task latency or quality. [Restoration/native evidence](../.cache/coding-reliability/runs/84a951bf-0ae1-4ef5-85ea-ce7c3394eaba/events.jsonl).

## First JavaScript completion (14 October, 21:34 UTC)

The first genuine JavaScript completion is recorded in current run
`c38dd81c-b702-4295-8616-014c511c6034`, task
`2c043b5b-f1ec-4a86-8dcf-b4bd43e344d1`. Its CLI case closed at
21:32:32.862 UTC after 2,435,760 ms (40.60 minutes) active time. The model edited
`stats.mjs` (635 bytes, recorded SHA-256
`06fa0cfed9d2743288f46bbff829262b077ff85b9062615470aee238595bd7b6`),
ran the exact requested protected check after its last mutation, and closed as
completed/verification-passed with zero host continuations. The independent
behavioral oracle, immutable `package.json`/`check.mjs` hashes, command receipts
and no-replay checks all passed, profile binding was verified, and all three
task cleanup stages fulfilled. The model corrected one invalid verification
`checkIds` request before the actual command ran; no unexecuted request was
counted as a test.

The [actual command receipt](../.cache/coding-reliability/runs/c38dd81c-b702-4295-8616-014c511c6034/profile/actions/2c043b5b-f1ec-4a86-8dcf-b4bd43e344d1/command-logs/c2420890-87be-4676-a362-5bae85561a67.json)
records exit zero at 21:26:59.181 UTC using the packaged local Node wrapper.
The [raw run report](../.cache/coding-reliability/runs/c38dd81c-b702-4295-8616-014c511c6034/report.json)
retains `falseVerified:false`/replay zero for this case. The subsequent repair
task `88893ef3-be00-4a11-acfd-df7a9bd582b0` closed blocked/unverified, as described
below. The whole run ended at 21:51:37.172 UTC with confirmed owned-process
shutdown and zero false verification/replay. No promotion is claimed. This is one measured code task,
not a full reliability score or a controlled comparison to other models.

The Desktop shortcut `~/Desktop/Free Local Agent.app` points to the checked
`release/mac-arm64/Free Local Agent.app` bundle. Package checks and this terminal
task remain separate from locked-desktop GUI proof.

## Terminal Qwen result and Muse calibration (14 October, 22:11 UTC)

The second Qwen fixture, `test-repair`, failed to complete. After an invalid
verification-criterion request, the model manually typed an executable path
under `/Users/mahdizareei` instead of the frozen `/Users/mehdizareei` path. The
host denied it before execution and stopped automatic retries. No implementation
mutation occurred. The protected package/test hashes remained unchanged, the
independent repair/command-receipt checks failed, and the task stayed
blocked/unverified with no false verification or replay. The terminal diagnostic
retains one passed and one failed case; it is not a full qualification score.

A new host verification-ID tool resolves the exact frozen command and working
directory without requiring the model to retype the executable path. Its initial
source check recorded 716/718 passes with two stale expected-tool-list assertions;
that failed check remains at `check-frozen-verification-final.log`. The corrected
source now passes 719/719 and type checking
(`check-frozen-verification-parity.log`), including action-client deadline parity
and a real HTTP delayed-approval regression. The source is frozen and rebuild
passed. The offline package and packaged smoke now pass with the new checked
ZIP digest recorded above. A fresh packaged Qwen pilot,
`qwen-q3-frozen-id-packaged-real-code`, has started in test-repair/CLI order with
the selected one-hour desktop budget and the new ID tool. Its source and native
profiles are frozen; its run ID is `601d5481-3e63-4bbd-a570-732268730344`.
This launch is later than the 22:11 saved model snapshot;
no new model repair or qualification is inferred before its actual report.

Muse's separate [CPU20 calibration report](../.cache/coding-reliability/muse-cpu20-native-calibration-v1/report.json)
closed successfully at 21:58:49.573 UTC using the exact Muse Q3 CPU20/Metal
profile, 16K Q8 cache, batch 128/microbatch 32 and the fixed native Chat/tool
probes. Its actual sample at 21:58:49.396 UTC had normal pressure and
7,615,004,672 bytes (7.09 GiB) available; fixed-probe decode measured 3.94
tokens/s. Its profile binds the exact artifact/template/engine/memory-plan
identity, and owned-process cleanup succeeded. It explicitly records
`kind:native-memory-chat-tool-calibration-only`, `codingTaskRun:false` and
`codingQualification:false`. This calibration is separate from the 29 acceptance
attempts, coding-task scores, whole-task pressure evidence and GUI proof.

## Correct repair code with incomplete task (14 October, 23:06 UTC)

Run `601d5481-3e63-4bbd-a570-732268730344` closed cleanly at 23:04:09.473 UTC.
The model repaired `sum.mjs` in task `fea9ca22-2519-4c71-8750-790477375d28`:
the recorded file is 377 bytes with saved SHA-256
`efb2564f3addfbcfef467b5904442636e5cdea2f3018e2b752c7cc44b1db1aaa`.
Every independent check passed: hidden behavior, original package/test hashes,
the actual requested-command receipts, observed original test failure before
the edit and success after it, and zero replay. The two actual implementation
command receipts record exit one at 22:39:58.927 UTC and exit zero at
22:51:27.880 UTC. This is verified correct repair behavior under the retained
oracle, with 42.57 minutes of active task time.

The task still closed `status:incomplete`, `verification:unverified`,
`passed:false`. Its helper brief omitted the explicit request beginning
`First run <quoted absolute executable> check.mjs to observe the failing test`,
and preparation accepted four manual semantic criteria with no command
criterion IDs. The host therefore retained manual checks as unverified rather
than relabeling an implementation receipt as verification. No manual criterion,
fixture, oracle or allowlist was changed to turn this run into a success. Correct
code and completed host task are separate evidence: the successful-task/case
counts remained two at the close of that historical run. The separate current
retry supplies the later third completed task.

The second CLI case was canceled after 187,062 ms during helper preparation,
before execution generations or project actions, to repair that host planning
failure. It supplies no model code failure or success. The run retains zero false
verification/replay and fulfilled cleanup. The [actual terminal report](../.cache/coding-reliability/runs/601d5481-3e63-4bbd-a570-732268730344/report.json)
and [successful post-edit receipt](../.cache/coding-reliability/runs/601d5481-3e63-4bbd-a570-732268730344/profile/actions/fea9ca22-2519-4c71-8750-790477375d28/command-logs/fdaf76b2-d53e-43c2-b801-aa6b3bf80bf5.json)
preserve the original distinction.

The narrow imperative-command parser and helper planning fixes are now in the
729-test checked, rebuilt, packaged and smoke-tested app. Six earlier focused
guidance checks are retained at `verification-guidance-draft-check.log`; these
software checks do not promote the original incomplete run. Fresh Qwen pilot
`9bbf0f6f-bc80-488a-b71c-fcde3323a0bc` runs test repair then CLI inputs on that
frozen package. Its first Implement stage began at 23:28:55 UTC. The 23:41 snapshot
contains an active report, no terminal case or task outcome, and normal calibration
at 23:25:29 UTC with 7,481,507,840 bytes (6.97 GiB) available. No additional
completed task is inferred.

The canonical status supplement at 23:43:57 UTC records this active task's actual
frozen helper contract: command criteria `c1` and `c2`, file-preservation criteria
`c3` and `c4`, no manual criterion, and the requested empty-input, negative-number
and type-error behavior retained in `sumEven`. This is evidence that the new
preparation path preserved the request; it supplies no completed-task result.
The current status also records no shared-memory/resource blocker and no active
memory/transport investigation. Earlier failures and investigations remain
explicitly historical, rather than being presented as current resource blockers.
These observations do not establish whole-task memory safety or reliability.

Coverage caveat for that active repair: the protected `check.mjs` asserts only
`sumEven([2,3,4]) === 6`. Actual verification-ID receipts for `c1` and `c2` passed
at 23:52:34 and 23:55:28 UTC, respectively, but both execute the same supplied
command. The broader criterion descriptions preserve requested intent; they do
not make that command independently cover negative numbers, empty input or
`TypeError` behavior. At case finalization, the separate independent-behavior harness check passed;
that later evidence is distinct from the supplied command coverage. Correct-looking
source readback alone supplies no substitute completion or behavior result. See the [actual protected test](../.cache/coding-reliability/runs/9bbf0f6f-bc80-488a-b71c-fcde3323a0bc/test-repair-1-ordinary/check.mjs),
[c1 exit-zero receipt](../.cache/coding-reliability/runs/9bbf0f6f-bc80-488a-b71c-fcde3323a0bc/profile/actions/e08c5fda-10bc-41cf-a8a5-83f30fe8dc84/command-logs/27644f0b-9385-41b2-8785-0f3feef41726.json)
and [c2 exit-zero receipt](../.cache/coding-reliability/runs/9bbf0f6f-bc80-488a-b71c-fcde3323a0bc/profile/actions/e08c5fda-10bc-41cf-a8a5-83f30fe8dc84/command-logs/fa2f2516-5d09-45cd-a7ec-3474509fda18.json).

A later milestone after that 23:41 comparison snapshot is now published. Qwen's
repair task `e08c5fda-10bc-41cf-a8a5-83f30fe8dc84` completed at 00:01:42.743 UTC
on 15 October (`status:completed`, `verification:passed`, `passed:true`). All six
independent checks pass, including behavior, immutable inputs, requested-command
receipts, the original failure followed by a successful rerun, and no replay.
Profile binding is true, all three task cleanup entries are fulfilled, continuations
are zero, and the case completed after 2,173,203 ms (36.22 minutes), with no false
verification or replay. This adds one real completed repair to the two successful
tasks in the earlier dated snapshot. The overall pilot remains active, with
`ownedProcessesStopped:false`; it supplies no final process-cleanup or full
qualification result. The refreshed generated report now includes this task
in its exact active cohort and retains the earlier incomplete repair separately.

The selected Qwen diagnostic then finished at 00:31:06.034 UTC on 15 October.
Its CLI task `70a8d927-8309-4ad6-a688-1acff17b805b` completed with verification
passed, all independent checks passing, zero continuations, true profile binding
and all three task cleanup entries fulfilled. The CLI case took 1,762,021 ms
(29.37 minutes). Both selected cases passed, with false verification/replay zero,
`profileStable:true` and `ownedProcessesStopped:true`; full qualification remains
false. Together with the two earlier completed tasks, there are now four genuine
Qwen task completions across their separate exact cohorts.

The existing serial one-shot queue then started Muse controller run
`c9ab48d6-d703-4ea1-bbe7-3327ca63bb82` at 00:31:07 UTC on the same 729-test
package, repair then CLI order and frozen source. Queue PID 51076/session 1915
and controller PID 55212 are recorded in canonical status; runtime initialization
events are saved. No acceptance report or Muse task outcome is published at this
snapshot. It is shown separately from the generator's active published-report
count. That one-shot queue remains separate from the later same-thread unattended
heartbeat described below.

At the 00:52 UTC refresh, Muse's active report is published. Native preparation
finished at 00:36:25.189 UTC; actual `model.calibrationMeasurements` sampled at
00:36:25.186 UTC records normal pressure, 7,602,913,280 bytes available,
12,652,724,224-byte RSS and 1,021,914,344-byte physical footprint. The measured
fixed-probe decode rate is 3.063294 tokens/s. These fields differ from cached
`hardwareAfterLoad` estimates and are used here. Repair task
`489355c0-427c-46d4-aeec-6e11cc7f3f5d` entered Implement at 00:42:03.873 UTC.
Its first `list_files` tool request was observed at 00:51:52.697 UTC and
completed at 00:51:52.729 UTC. The protected test still has only the positive
`sumEven([2,3,4]) === 6` assertion; broader negative/empty/type-error behavior
awaits independent checks. No task/case completion, coding pass or final
owned-process cleanup is yet recorded. Active coding is not a stopped-before-task result; the report has no
finalized task record until the controller publishes an outcome.

The existing same-thread heartbeat **Finish free local model validation**
(`finish-free-local-model-validation`) is now actually created and enabled every
15 minutes. Its saved configuration was read and verified ACTIVE, targeting
`01a1394e-3217-7b21-8b5a-cc8658300e9a`. It continues the remaining work after
model cleanup: finish Muse, review and validate the scoped command-evidence
presentation fix, prove and test actual 80B SSD execution, run the separately
bound matched slow-system benchmark and deliver the checked app/report. These
steps remain pending; enabled continuation is no claim of their success.

The task-scoped `keep-validation-awake.py`/caffeinate helper is active (owned
session 82638, PID 61008), bounded to 72 hours, and stops with a completed or
disabled continuation. It preserves screen lock, display sleep and persistent
power settings. See [canonical status](../.cache/coding-reliability/implementation-status.json),
[dated handoff](../.cache/coding-reliability/UNATTENDED-NEXT-STEPS.txt) and
[owned awake state](../.cache/coding-reliability/validation-awake-v1.json).
All app-model inference remains free and local; GUI interaction remains unproven
while locked. No duplicate scheduled continuation was created by this refresh.

The later 01:07 UTC snapshot records an actual Muse failure. Repair task
`489355c0-427c-46d4-aeec-6e11cc7f3f5d` closed blocked/unverified at
00:57:39.358 UTC; its case finalized at 00:57:39.746 UTC after 1,274,157 ms
(21.24 minutes). Implementation action
`09211040-dd83-4501-9be7-1e42fa1570f9` removed only the outer executable quotes
from the frozen command's path containing spaces. The exact allowlist denied it
before execution, so no command receipt or source edit exists. Protected input
checks pass, while independent behavior fails (`9 !== 6`), requested-command
receipts fail and observed repair fails. Replay/false verification are zero;
all three task cleanup entries are fulfilled and profile binding is true.
There is no observed memory stop. These facts supply no Muse success.

The second CLI task `80fb2700-a76a-4eaf-95ff-729db405b654` entered Implement
at 01:03:52.371 UTC. Its outcome and whole-run process cleanup remain pending.
The private preapproval quote-hint draft and command-evidence scope draft remain
unapplied, with quote-draft tests not run. The proposed hint is narrowly bounded
`INVALID_ARGUMENT` feedback, with no automatic quoting/execution, command-ID
inference or permission widening. The original denial remains in the evidence.
After the active CLI stops and cleanup is confirmed, the continuation will
review/validate those changes and run fresh isolated Muse tasks before actual
80B proof. It will not replay or relabel the denied original repair.

Muse CLI `80fb2700-a76a-4eaf-95ff-729db405b654` later completed
at01:25:27.890UTC: statuscompleted/verificationpassed,5/5independent checks,
true profile binding, continuations0 and all3task cleanup entries fulfilled.
Its case took1,668,124ms(27.80min). Whole run ended01:25:28.749UTC with
profileStable/ownedProcessesStopped true. Original repair remains failed;
current Muse selected outcome1/2 stays separate from Qwen2/2 and older cohorts.

After queue cleanup, the quote hint, command-evidence display and report-label
fixes were applied. Combined focused171checks(reportsubset11), full746checks,
TypeScript and build passed. Offline packaging is active; final smoke/identity
and fresh isolated Muse tasks remain pending in this snapshot. The exact729
package used by both model diagnostics is preserved as [the archived ZIP](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-a2cda6dca8aa.zip).
Earlier results are not attributed to the later source. Fresh Muse tasks after
the new checked package precede actual80B proof.

The newer source subsequently passed all 746 checks, TypeScript, offline build,
package and smoke. ZIP SHA-256 is
`9eda1a53b29b20ffc8e70f4c050c1a20aee3f801d2aa04a8e55aa1245e8605f8`;
the exact 729-package artifact used for earlier runs remains archived separately.
Fresh Muse run `b0ce0081-97c3-4430-96f0-147eb61c550a`, label
`muse-q3-quote-guard-746-packaged-real-code`, is actually active under owned exec
11837, controller 69869/caffeinate 69870. Source/resources/package remain frozen.
Its initialization precedes a published acceptance report, so it is shown
separately from the generator's active-report count until that report exists.
No fresh task success or improvement is inferred. The app process 69833 is open
behind the lock; native GUI interaction remains unverified.

At the 01:52 UTC refresh, fresh746Muse b0ce has a published acceptance report.
Native preparation completed at01:44:17.177UTC. Its actual
`model.calibrationMeasurements` sample at01:44:17.175UTC records normal pressure,
7,561,232,384bytes available,13,107,216,384-byte RSS and1,022,110,952-byte physical
footprint. Fixed-probe decode measured3.717975tokens/s, using the exact same
CPU20/16K/4096/batch128/micro32/Q8profile. These are measured calibration fields,
not cached hardware estimates or whole-task coding performance.

Helper preparation remains active. A saved native log at01:50:39.965UTC records
1,408prompt tokens processed at94%progress/10.53tokens/s, a partial helper-prefill
sample. No coding-stage event or task/case result is recorded; model runtime
ready does not establish coding reliability, final cleanup or qualification.
Generator active-report count is now1, replacing the earlier unpublished-init
supplement. Old729Qwen2/2 and Muse1/2 package-bound results remain separate;
identical native-profile aggregates must not become a matched package score.

Fresh746Muse repair `38a9d8cc-8d59-4ca2-8910-385480b7421b` entered Implement
at01:59:17.300UTC. Initial implementation command action
`266ef46a-e188-4f46-946a-8ede0fac0567` retained the executable quotes and
actually exited1 before any edit (receipt finished02:13:29.263UTC, tool event
02:13:29.265UTC). Approved edit `0de40611-5ae9-4a4f-87eb-04699ec48396`
wrote328bytes to sum.mjs at02:18:10.881UTC, saved SHA-256
`f31319d23c03e93df7aa4cd4a1206129f24ffd6099ddc67bd18106e575c42e51`.
Explicit `run_verification` for `check-1`, action
`7a4c6ce0-9ea8-4f30-9f91-ca3a36f27905`, ran the same exact quoted command
local-only and exited0 (receipt02:20:20.662UTC, event02:20:20.664UTC).

The active report still has no finalized tasks/cases. The command's single
positive-example test does not establish all requested behavior; task closing,
independent checks and whole-run process cleanup remain pending. No new task
completion or qualification is counted. The quote guard was not triggered
because the model retained quotes; this run does not establish a causal guard
benefit. Saved [initial failure receipt](../.cache/coding-reliability/runs/b0ce0081-97c3-4430-96f0-147eb61c550a/profile/actions/38a9d8cc-8d59-4ca2-8910-385480b7421b/command-logs/266ef46a-e188-4f46-946a-8ede0fac0567.json)
and [actual verification receipt](../.cache/coding-reliability/runs/b0ce0081-97c3-4430-96f0-147eb61c550a/profile/actions/38a9d8cc-8d59-4ca2-8910-385480b7421b/command-logs/7a4c6ce0-9ea8-4f30-9f91-ca3a36f27905.json)
retain exact command, purpose, check ID and network scope.

Fresh746Muse repair `38a9d8cc-8d59-4ca2-8910-385480b7421b` subsequently
completed at02:24:47.203UTC; its case finalized at02:24:47.539UTC after
2,430,006ms(40.5001min). Taskstatuscompleted/verificationpassed, all6independent
checks pass, profile bindingtrue, continuations0 and all3task cleanup entries
fulfilled. False verification/replay remain0. This adds one genuine repair
completion, for6total across distinct packages(4Qwen+2Muse).

The saved frozen brief has exactly one command criterion(`check-1`) and two
file-preservation criteria, no manuals, while retaining all requested behavior
in the goal. The actual acceptance row says `Approved command passed` and
explicitly limits that result to command/checked-file evidence, with planned
behavior coverage unverified. The separate independent-behavior check later
passed. Quote guard was not triggered because quotes were retained; no causal
benefit is inferred from this completion.

The second CLI `a4c13141-b54f-4671-8a06-34a5e45bd5fd` entered Implement at
02:29:51.509UTC and remains active. Whole-run `ownedProcessesStopped:false` is
retained. One completed task is not a completed model run or qualification.
Old729Qwen2/2 and Muse1/2 remain distinct from the746repair pass/CLI pending.

Fresh746Muse CLI `a4c13141-b54f-4671-8a06-34a5e45bd5fd` completed at
02:52:43.979UTC; case finalized02:52:44.703UTC after1,676,420ms(27.9403min).
All5independent checks pass, profile bindingtrue, continuations0, all3task cleanup
entries fulfilled and false verification/replay0. Model edit/readback evidence
records512-byte stats.mjs with saved SHA-256
`bb28ab47d0be590ae1ef2151509f2628b5d53ac299381010076707f43001e7b0`.
Whole run ended02:52:44.811UTC, passed2/2, profileStable/ownedProcessesStopped true.
Owned exec11837closed exit0 and old controller/caffeinate/native processes were
confirmed absent by the parent. Source freeze was lifted only after cleanup.

Fresh 746 Muse 2/2 remains separate from archived 729 Qwen 2/2 and Muse 1/2.
Seven task completions across these and earlier profiles do not form a pooled
qualification score. The following later 80B results supersede earlier pending
snapshots without changing their saved failures or source identities.

## Actual 80B SSD proof and coding diagnostic (15 October, 04:50 UTC)

The applied initial SSD source passed 769/769 checks and TypeScript. Its failed
767/768 predecessor is retained in
[qwen80-full-source-check-v1.log](../.cache/coding-reliability/qwen80-full-source-check-v1.log).
The native 8K resources and private fixtures were rebuilt and verified. These
software results precede the newer readback/budget changes; they do not validate
those changes or establish model coding quality.

The immutable [first numerical proof](../.cache/ssd-engine/qwen80-proof-run-8k-v1/process-report.json)
failed before comparison math because required per-layer `post_moe` diagnostic
labels were missing. A secondary missing-`comparison.json` inventory error masked
that primary error in its original top-level result. Both facts remain retained.
Full shard checks, representative expert checks and ordinary/streamed native
substeps exiting zero did not turn the overall proof into a pass. Its 5,178
normal-pressure samples and 2,747,318,272-byte peak child RSS cover two partial CPU
layers, not a full 80B model.

After the reviewed diagnostic/residual-witness repair, the distinct
[second proof](../.cache/ssd-engine/qwen80-proof-run-8k-v2/process-report.json)
and [comparison](../.cache/ssd-engine/qwen80-proof-run-8k-v2/comparison.json)
passed: 449 common nodes / 16,901,864 values had zero absolute and relative
difference; 40 residual F32 ADD comparisons / 401,408 values were exact; 49 logit
vectors agreed in top-1/top-5. Twenty real alias witnesses were retained per mode.
The independently reviewed installed
[scoped certificate](../resources/ssd-inference/darwin-arm64/validation/qwen3-coder-next-80b-standard-cpu-8k.json)
has SHA-256 `6298f1410b210824701d466880c1a5252b732b42ba71b03eb3c937768925094b`.
Its scope is representative experts and **two original hybrid CPU layers**
(original recurrent layer 0 and attention layer 3), up to 18 teacher-forced tokens
inside an 8K-capacity profile. It does not cover all 48 layers and accumulated
drift, full 2,048-token generation, Metal, coding quality or four-hour stability.
The partial proof's raw `fullModelLoaded:false` remains true of that proof;
later certificate publication and full-model runs are separate evidence.

The first real full-model source diagnostic,
[run 2866725a](../.cache/coding-reliability/runs/2866725a-be5c-4363-a3e2-d29a23ece635/report.json),
used CPU, 8K context, 2,048 output, batch 64/microbatch 16, F16 KV, 30 expert-cache
slots per layer, four decode/batch threads and no recurrent checkpoints. All
48 streamed groups loaded and real Chat/tool probes passed. The short startup
probe measured 7.698 tokens/s; this is not coding-task performance.

The whole run ended at 04:49:49.173 UTC, exit 1, **0/2 cases passed**, with
`profileStable:false` and `ownedProcessesStopped:true`:

| Case | Final result | Actual retained evidence |
| --- | --- | --- |
| `exact-lf` | Timed out at the original one-hour limit | The model wrote and fully read 26 bytes, missing required final LF; independent oracle expected 27 bytes and failed. One write and one ordinary native read completed; no successful repair. |
| `cli-inputs` | Blocked before coding after fresh preparation (94.85 s) | Allocation budget changed from 11,149,564,313 to 6,727,991,296 bytes and resident limit from 11,736,383,488 to 7,264,862,208. The strict profile guard stopped it with zero actions/tools/command receipts; computation geometry stayed 8K/30 slots. |

The first task also retained a routine read/report requirement as an unverified
manual criterion. That preparation defect is distinct from its wrong file bytes.
The model began an incorrect “Verified” prose claim, but the host stayed failed /
timed out. Both tasks had profile binding verified, all three cleanup entries
fulfilled, zero replay and zero false verification. The parent independently
confirmed controllers and both owned native workers absent. Missing top-level
`error` did not mean the run passed. The profile guard and original report remain
unchanged; the CLI scaffold's independent failure is not model-generated code.

Actual long requests show why a short probe rate is insufficient:

| Request | Prompt processing | Decode | Completed request time |
| --- | --- | --- | ---: |
| Helper preparation | 1,057 tokens / 223.64 s / 4.73 t/s | 192 / 29.95 s / 6.38 t/s | 4.23 min |
| Write file | 3,640 / 945.73 s / 3.85 t/s | 57 / 10.05 s / 5.57 t/s | 15.93 min |
| Read file | 3,872 / 1,100.90 s / 3.52 t/s | 105 / 19.31 s / 5.39 t/s | 18.67 min |
| Partial closing | Last observed 4,224 of 4,242 prompt tokens / 1,248.06 s / 3.38 t/s | Partial assistant output; no final decode receipt | Interrupted by task deadline |

The exact-file task recorded one preparation and three execution generations,
zero finalization generations, two completed tool round trips and zero automatic
host continuations. No completed timing was invented for the interrupted request.
Its wrong 26-byte file SHA-256 was
`8e560e3b95a3c4740b89a596e1863a88202570dfefa541666ac1001625643bf7`.
The final LF was absent in the model's parsed tool arguments; the host wrote the
approved content exactly. No operator changed the fixture to obtain a result.

Streamed extraction of the terminal event file found 1,891 distinct positive-RSS
host measurement timestamps, all with normal pressure: minimum available memory
4,498,767,872 bytes, peak RSS 4,834,017,280 and peak footprint 4,787,064,912 bytes.
These include setup/calibration and both preparations as well as coding. Native
ledgers separately carry actual PIDs; host measurement rows do not. The first
native worker's cumulative expert-read counter reached 5,157,850,521,600 bytes;
the second preparation's worker reached 114,993,045,504. These are local read
counters, not network traffic, an independent physical SSD-bus benchmark or a
quality score. No memory-pressure stop was observed; sampled memory behavior
does not establish correctness or universal weak-system support.

The [offline report](../.cache/coding-reliability/local-model-benchmark-report.html)
and [JSON provenance/metrics](../.cache/coding-reliability/local-model-benchmark-report.json)
retain this original failed run separately from requested-model successes,
partial numerical proof and source checks. At the close of this historical
one-hour snapshot, the readback/four-hour changes awaited fresh runs. The later
870 Qwen/Muse passes and failed four-hour 80B diagnostic are recorded below;
none relabels this one-hour run. The 866-check package passed smoke and was
reopened. Matched slow comparison and interactive GUI proof remain unfinished.

## Qwen readback preparation failure and prompt repair (15 October, 05:22 UTC)

Fresh [run 2084135c](../.cache/coding-reliability/runs/2084135c-d733-4ba1-94bc-a669a2077cba/report.json)
used the checked 866 package and current controller with Qwen Q3, Low memory,
the original one-hour desktop budget, unmodified `exact-lf` fixture and repeat 1.
It ended at 05:22:34.499 UTC, exit 1, **0/1 passed**. Task
`163e36c0-79be-48c2-9ba3-1d59e7c98649` closed blocked/unverified after 686,128 ms
(11.44 minutes), with three preparation generations, zero execution/finalization
generations and no frozen brief. No edits, read tools, commands or approvals ran.
The independent missing-`note.txt` failure records that no task execution occurred;
it is not a test of generated code or proof that the new readback chain worked.

The final retained Zod error rejects extra `version` and `readback_file` keys at
`criteria[1]` and reports the invalid/missing top-level `version: 2`. These are
placement errors in the final plan, not accepted readback criteria. The first two
raw helper responses are not retained, so their exact shape or error cause is
unknown; the three preparation counts do not prove all attempts made the same
mistake. No invalid JSON was coerced or accepted.

The run retained `profileStable:true`, verified task profile binding, all three
fulfilled task cleanup entries, confirmed whole owned stop, zero continuations,
false verification and replay. Controller 39472 and native worker 39542 were
confirmed absent by the parent. Missing top-level `error` did not turn this task
into success. All earlier Qwen/Muse cohorts and the original 80B 0/2 are retained.

The applied [two-path prompt repair](../.cache/coding-reliability/readback-planner-prompt-repair-v1/inventory.json)
adds explicit supported-readback version-2 format guidance: one root `version:2`,
a flat `exact_file` row and a separate flat `readback_file` row linked by
`exactCriterionId`. It changes the planner instructions and illustrative JSON,
not strict parsing, evidence predicates, the three tries, approvals, budgets,
manual semantics or independent fixtures. Its recorded patch is
`a6ff276c94a0bf692e1fb96b3669771f325849409321e41c3ce87394f426380f`.
It passed 86 focused checks, TypeScript and 869 full Node checks before the
subsequent edge-case amendment.

Independent review found that an example could copy a request longer than the
2,400-character goal bound. The applied [one-path amendment](../.cache/coding-reliability/readback-planner-prompt-repair-v1/long-goal-amendment-v1/inventory.json),
`c9aeed6e0d9d91baa49291c73ee17712a5d26583524826bb2ec9a228077cfa55`,
uses a bounded example goal; the complete original user request stays present and
untruncated. A fourth regression was added for that distinction. Final TypeScript
and 870/870 Node checks passed. The offline package built successfully with SHA-256
`1404f8e66f74f680872d1cb7c4366fc1b84ceea92fdefaf1f5af1d8ab07a21f9`;
its smoke check passed and the app was reopened. Fresh real Qwen/Muse trials
remain pending in this snapshot. These software changes grant no coding pass, full readback proof,
full-model numerical certificate or qualification, and never relabel run 208.

## Completed Qwen V2 readback task (15 October, 05:56 UTC)

Fresh [run 669ed20b](../.cache/coding-reliability/runs/669ed20b-daac-4538-b0af-feb5a773e534/report.json)
on the checked 870 package ended at 05:56:18.622 UTC, exit 0, **1/1 passed**.
Task `4257ee4d-5a23-4a0d-813a-5ffc53b4e036` completed with verification passed
after 809,418 ms (13.4903 minutes), one preparation and four execution generations,
zero finalization generations and zero host continuations. This is a new UUID and
one unmodified exact-file diagnostic; the earlier 866 planning failure stays 0/1.

The frozen version-2 brief contains separate linked `exact_file` and
`readback_file` criteria. One approved write created the required 27 UTF-8 bytes
including final LF, SHA-256
`8cebbc7816ea1c3bdbd2db407941ff64fa5b8ce17cdb6cc0de436c744f04ce96`.
The ordinary native full read returned byte range 0–27, EOF, no truncation and a
readback nonce. The saved host exact-content report at 05:56:18.179 UTC precedes
Verify at 05:56:18.181; its escaped JSON preserves the final LF and matching SHA.
The final two acceptance rows, independent exact-byte/no-replay checks and verified
profile binding pass. All three cleanup entries fulfilled, the whole profile was
stable, owned processes stopped, and false verification/replay remained zero.

The [independent evidence audit](../.cache/coding-reliability/qwen669-readback-evidence-audit-v1/audit.json)
and [raw provider review](../.cache/coding-reliability/qwen669-readback-evidence-audit-v1/CHILD-PROVIDER-BINDING-REVIEW.txt)
found no blocker to this scoped completion. The saved Goose input contains the
exact adjacent read call/result, native fields and nonce. No separate final-gateway
wire trace, private finalization token or GUI canonical transcript was retained;
normal delivery is supported by the checked live gate and actual ledger/end-turn
result. The report answer and host-report event are durable. No compaction archive
was needed. The model's optional abbreviated SHA suffix was wrong (`96cf`);
the appended host report contains the correct full SHA. This completion does not
verify every model statement or prove forced compaction, interactive GUI behavior,
broad repository-task success, cloud-model equivalence or full qualification. At
this 05:56 snapshot, Muse V2 readback and the separate 80B diagnostics were still
pending; their later outcomes follow. Matched slow comparison and GUI interaction
remain unfinished. Historical Qwen/Muse cohorts and the original
80B 0/2, failed V1 proof and limited V2 CPU-layer certificate remain unchanged.

## Completed Muse V2 readback task (15 October, 06:23 UTC)

Fresh [run1cab81bf](../.cache/coding-reliability/runs/1cab81bf-7a95-4f3c-adbb-7492f08865da/report.json)
on the same checked 870 package ended at 06:23:16.315 UTC, exit0, **1/1 passed**.
Task `fdb5195f-fe5f-41fb-b4e0-f92eea584f50` completed/verification-passed
in 810,384ms (13.5064minutes; case time810,385ms), with one preparation, three
execution generations, no finalization generation and no host continuation.

The unchanged exact-LF fixture produced one approved 27-byte UTF-8 write with
final LF and SHA-256
`8cebbc7816ea1c3bdbd2db407941ff64fa5b8ce17cdb6cc0de436c744f04ce96`.
The ordinary native read returned the complete 0–27-byte range, matching text/hash,
EOF, no truncation and a nonce. The exact escaped host report was durably saved
at 06:23:15.765 UTC before Verify at 06:23:15.767. Both linked version-2 acceptance
rows and both independent exact-byte/no-replay checks pass. Profile binding and
whole profile stability hold; all three cleanup entries fulfilled, owned workers
stopped, false verification/replay remained zero, and no command was requested.

The [parent joined audit](../.cache/coding-reliability/muse1cab-readback-evidence-audit-v1/audit.json)
finds no scoped acceptance blocker. The written [child provider review](../.cache/coding-reliability/muse1cab-readback-evidence-audit-v1/CHILD-PROVIDER-BINDING-REVIEW.txt)
also finds no blocker in the native call/result and completion evidence; the
parent and root have reviewed that note. As with Qwen, the
logged adjacent Goose pair and passed live gate/task result support scoped
readback acceptance. No separate post-gateway wire trace, private finalization
token or GUI canonical transcript was retained, and no populated compaction
archive was needed. These are evidence limits, not proof of forced compaction
or interactive GUI behavior.

Qwen and Muse each passed one exact-LF task on 870, with distinct model profiles
and saved outcomes. This is not a controlled broad quality/latency comparison, a
new repository repair, or full qualification. Across retained requested-model
cohorts there are nine completed tasks (five Qwen, four Muse). The failed 866 Qwen
preparation and original 80B 0/2 remain unchanged. Native computation and the
limited two-hybrid-CPU-layer certificate are unchanged. The first explicit
`ssd-selected-4h-v1` 80B exact-file source trial later finished 0/1, followed by
a distinct fresh 877-source 1/1 pass. The following CLI trial failed before coding
on host context admission. A distinct later 879-source CLI trial ran the approved
command and passed its bounded checks, but also ended blocked. The matched slow
108 cases and GUI task proof remain unfinished.

## Full 80B four-hour exact-file result and diagnostic feedback (15 October, 10:41 UTC)

The separate source-only [run 17ac6ad0](../.cache/coding-reliability/runs/17ac6ad0-912d-4bc6-8eea-8ea4b2921bf7/report.json)
ended at 10:41:00.443 UTC, exit 1, **0/1 passed**. Its single task
`2b5e5e1b-4ac2-4baa-84c7-c6856a06a6e2` remained blocked, incomplete and
unverified after the original 14,400,000 ms budget. The task records
`SSD inference was interrupted; pending actions must be cancelled.` The frozen
version-2 brief still requires exactly 27 UTF-8 bytes including final LF and a
separate actual readback/report. The final file remains 26 bytes without LF,
SHA-256 `8e560e3b95a3c4740b89a596e1863a88202570dfefa541666ac1001625643bf7`;
the independent byte oracle failed. No operator altered its contract or file.

The retained actions include one initial approved write, three full ordinary
reads of the wrong 26 bytes, an inspect operation and a final unchanged 26-byte
write. None of those reads received a trusted readback nonce, and no durable
successful readback report exists. The host rejected three inaccurate success
claims and entered Repair three times. The report's `continuations:0` counts
interrupted-return continuations, not these ordinary Repair transitions. The
last completed model prose identified the missing LF, but its parsed write
argument still omitted LF; the host truthfully returned an unchanged-file
receipt. There were one preparation and ten execution generations, zero
finalization generations, no replay and no host false verification. These are
rejection and failure records, not model repair success.

The [terminal independent review](../.cache/coding-reliability/qwen80-17ac-terminal-audit-v1/FINAL-REVIEW.txt)
confirms stable profile/source binding, all three fulfilled cleanup entries,
`ownedProcessesStopped:true`, consumed exit 1 and process absence at 10:47:03.833
UTC. Five populated recovery parts, nine entries and 14 archived messages were
independently checked. Actual compaction occurred; successful readback through
compaction was not established. No final HTTP wire/private-token capture or
pre-native-parser generation was retained. Agreement between parsed Goose
arguments, host input and file bytes proves faithful delivery of those arguments;
it does not identify whether model generation or delimiter framing omitted LF.

The runtime event stream has 7,240 distinct normal-pressure measurement timestamps:
7,238 have positive native RSS/footprint and two initial samples are missing or
nonpositive. Peak RSS
was 4,836,245,504 bytes, peak footprint 4,789,276,776 and minimum host-available
memory 6,079,823,872 bytes. Host sample rows have no PID; separate native ledgers
identify the owned worker. This is not the separate 100 ms observer or a proof
of general weak-system support. A generic native expert-load I/O error/backtrace
at 10:40:59.884 UTC appears 10 ms after the task boundary. The same source guard
can fire during shutdown/stopped state, so the marker is retained without
claiming a physical disk failure or a diagnosed native defect. The failed case
establishes neither coding quality, four-hour stability, qualification nor
full-model numerical equivalence; the earlier partial CPU certificate keeps its
original limited scope.

After terminal cleanup and independent review, the [two-path diagnostic application](../.cache/coding-reliability/exact-file-diagnostic-fix-v1/applied.json)
was applied to working source. A failed valid `exact_file` check may now report
expected/actual UTF-8 byte counts, the first differing zero-based byte offset and
which side reached EOF. It identifies exactly one missing final LF only when the
entire actual file equals the expected prefix and the sole expected extra byte
is LF. These numeric facts use the same successful guarded snapshot, with no
reread, content snippets or byte values. Invalid surrogate expectations or
snapshot failures keep the prior generic/error detail. Existing secret, symlink,
race, size and fatal UTF-8 protections remain unchanged.

The new failed-check wording applies to both V1 and V2 exact-file criteria;
acceptance equality, statuses, IDs, evidence fields, frozen criteria, actual
readback/report requirements, manual review, approvals, effects and budgets are
unchanged. It cannot manufacture a readback receipt or repair a file. At this
documentation update, 51 focused checks, all 877 Node checks, TypeScript and
resource verification passed. The subsequent offline build/package and smoke
also passed. The preserved 877 [ZIP](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-e354fe01d46e.zip)
is 229,609,694 bytes, SHA-256
`e354fe01d46eff9f02f19569d484f09d21d299836a718f7b9b3719b65d2be5fa`.
The app was reopened from its exact bundle; locked interactive GUI behavior
remains unverified. The earlier 1404 SHA identifies the distinct 870 package
used for the successful Qwen/Muse pilots. At that post-failure checkpoint no
fresh model result existed. The later source-only 80fb completion follows; the
failed run and its original feedback remain immutable. The later success does
not establish diagnostic causality or general coding reliability.

## Completed full 80B source exact-file task (15 October, 14:03 UTC)

The fresh source-only [run 80fb6b44](../.cache/coding-reliability/runs/80fb6b44-eda0-4631-8da7-2d5e2dba1b67/report.json)
ended at 14:03:33.490 UTC, exit 0, **1/1 selected exact-file case passed**. Task
`baf03665-a7f9-4f7a-805f-026e3b0da200` completed with verification passed and
normal `end_turn` after 10,905,366 ms (181.7561 active minutes), one preparation,
seven execution generations, no finalization generations and one host
continuation. It used the checked 877 source/resources and the distinct explicit
`ssd-selected-4h-v1` budget, not packaged-controller inference. The frozen
27-byte LF requirement and linked actual readback/report criterion were unchanged.
This is a selected source diagnostic, not qualification or a pooled success rate.
The requested-model totals remain 36 terminal attempts, 26 cases and nine
completed tasks (five Qwen, four Muse), with no qualifications.

The initial approved write at 11:26:36.867 UTC still produced 26 bytes without LF.
Its first native read confirmed those wrong bytes and had no readback nonce. An
inaccurate exact/LF prose claim was rejected by Verify → Repair at
12:08:50.661/.662. Later model prose recognized the missing LF, but its next
parsed write still omitted LF: the host returned unchanged/26 bytes at
12:35:32.719. These wrong bytes, prose and no-op results remain in the history.
An actual subsequent `edit_file` operation completed at 13:03:22.651, changed the
file to 27 bytes including LF and produced SHA-256
`8cebbc7816ea1c3bdbd2db407941ff64fa5b8ce17cdb6cc0de436c744f04ce96`.
That real edit, rather than a success claim, supplies the retained repair.

The final ordinary native read returned the complete 0–27 byte UTF-8 result,
matching content and SHA, EOF, no truncation and a valid receipt nonce. The next
retained Goose request contains the exact adjacent native call/result pair with
matching tool-call ID. After normal completion, the exact escaped host report
was durably saved at 14:03:32.911 UTC before Verify at 14:03:32.914. Both linked
acceptance checks and the independent exact-byte/no-replay checks passed. The
host result therefore rests on actual bytes, delivered readback and durable
publication as well as the independent checks; exit 0 alone does not establish
that evidence.

Profile stability and final source/resource binding comparison passed, all three
cleanup entries fulfilled, owned processes stopped, and false verification and
replay stayed zero. The real execution-session exit was consumed as 0; controller
95033, native worker 95071 and all native workers were absent at 14:06:20.012 UTC.
The task and runtime error values are explicitly null; the report's optional
top-level error key is absent. The [terminal snapshot](../.cache/coding-reliability/qwen80-80fb-terminal-snapshot-v1/summary.json)
retains report SHA-256
`2315c737070b502a9a7bf1cd175a9e66c6632217de0dc21796cc0c61725373fc`
and final binding digest
`73b0297ca588c5a7843a5f628614bf82404edbd7a3bde9f0dce2163abc9cf612`.
The completed [joined independent review](../.cache/coding-reliability/qwen80-80fb-terminal-audit-v1/FINAL-REVIEW.txt)
found no concrete blocker to this one-case pass within its retained-evidence
limits. The [current binding recheck](../.cache/coding-reliability/qwen80-80fb-terminal-audit-v1/CURRENT-BINDING-RECHECK.json)
rehashed all 87 bound source files and 624 non-weight resource files: all matched,
with no missing/extra paths or files changing during reads. Native identity,
computation profile and the same limited certificate matched. No model weights
were read or rehashed by that audit. The raw provider review checked all seven
completed coding logs and five unique calls (two writes, two reads and one edit).

The runtime event stream retains 5,492 distinct normal-pressure measurement
timestamps: 5,490 have positive native RSS/footprint and two startup readings are
missing or nonpositive. Peak RSS was 4,858,626,048 bytes, peak footprint
4,811,821,184 and minimum host-available memory 6,560,038,912 bytes. Host rows
lack PID; native ledger/ownership evidence is separate. These are runtime events,
not the separate 100 ms observer, isolated model-only memory demand or four-hour
stability evidence. Seven completed coding requests had prompt-processing rates
of 3.21–3.53 tokens/s and decode rates of 4.76–5.58 tokens/s, with repeated prefix
work retained. These individual request timings are not a general task-completion
rate or coding-quality measurement.

No separately saved final prepared HTTP wire, private one-use finalization-token
trace or pre-native-parser generation is retained. Delivery and healthy drain
are supported by the checked executed live gates and retained normal outcome,
not an independently saved full transport trace. Awaited atomic report
persistence is established; physical fsync was not independently demonstrated.
The successful task has recovery `parts:[]` and 40 exact unused placeholders,
with no populated recovery archive or forced-compaction test; the failed 17ac
archive and all older failures remain separate. Parsed wrong-write arguments matching
host/file bytes do not settle whether generation or delimiter framing omitted LF.

This is one repaired exact-file/readback success. It does not establish broad
coding reliability, controlled diagnostic benefit, full 48-layer numerical
equivalence, four-hour stability, GUI interaction or cloud-model equivalence.
The original one-hour 0/2 run and four-hour 17ac 0/1 run are not relabeled. The
partial CPU certificate keeps its original representative-expert/two-hybrid-layer
scope. At this 14:03 checkpoint the next requirement was a separate source-only
four-hour CLI case. That case subsequently failed on host context admission, as
recorded next; it did not change this exact-file success. The following limited
default-page change subsequently received its own fresh 879-source CLI trial:
its real command and bounded checks passed, but the agent remained blocked, as
recorded below. The matched slow 108-case/117-phase benchmark and GUI task proof
remain unfinished. Public networking stays disabled for coding tests.

## CLI context-admission failure and default text-page change (15 October, 15:06–15:34 UTC)

The separate source-only [run aa7b3826](../.cache/coding-reliability/runs/aa7b3826-c02d-4ff8-b06d-9c898cb2cfd2/report.json)
ended at 15:05:59.979 UTC, exit 1, **0/1 CLI case passed**. Task
`2f6002fe-c013-4a6b-add7-ace0935ed22b` remained blocked, incomplete and unverified
after 2,584,686 ms (43.0781 active minutes), with two preparation generations,
one execution generation, no finalization generation or continuation, and no
replay or false verification. The optional top-level error key is absent; the
task error explicitly records that the request, instructions and pending tool
results exceed the model's context. The report's `mandatoryPassed:true` does not
override this failed case or its unverified required command.

The only actual tool call read the preflight guidance at 15:05:52.355 UTC. That
file contains 8,644 bytes; the native result delivered the first 4,000 UTF-8 bytes,
range 0–4,000, with EOF false, truncation true and a continuation cursor. The
returned text matched the file prefix and full-file SHA. It was a successful
partial read, not complete readback. Retained-history `toolsTruncated:false`
does not make the native result complete. The adjacent generated read call and
next provider input's tool result were independently matched. That next request
received host HTTP 400 `InferenceBudgetError` / `CONTEXT_LIMIT`, with no generated
output or usage; the provider-error wrapper was not a model answer.

The gateway's existing native-count admission guard rejected input plus reserved
output exceeding its context allowance before the next decode/step consumption.
The full prepared HTTP body and exact contributing private token counts were
not retained, so no exact count or broader cause is invented. No repository
write, approval or command ran. `stats.mjs` stayed its original 48-byte comment
scaffold; `package.json` and `check.mjs` stayed unchanged. Preservation passed,
the required command remained unverified and the independent command-receipt
check failed. The independent behavior check encountered empty JSON from that
unchanged scaffold: this proves noncompletion, not poor generated code. The full
frozen V1 goal and exact quoted command remain unchanged.

The completed [independent review](../.cache/coding-reliability/qwen80-aa7b-terminal-audit-v1/FINAL-REVIEW.txt)
found matching current hashes/sizes for all 87 source files, 624 non-weight
resource files, 18 native inventory records, the unchanged scoped certificate
and prelaunch document. The stored source/resource binding stayed stable; the
auditor did not read or hash model weights. Report SHA-256 is
`102630e5fdf6412ce0988a0fb40a787526645faf2000a6f71b96fcaf161cbbd2`.
All three cleanup entries fulfilled, owned processes stopped, the real execution
exit 1 was consumed, and controller 22916/native worker 22950 were confirmed
absent with no remaining native workers or validation controllers. The earlier
80fb exact-file pass and all failed cohorts remain unchanged.

The event stream retained 1,333 distinct normal-pressure timestamps: 1,331 had
positive RSS/footprint and two initial readings were missing or nonpositive.
Peak native RSS was 4,863,950,848 bytes, peak footprint 4,817,014,912 and minimum
host-available memory 6,613,417,984 bytes. No native fatal or runtime error marker
was found; the host context error is retained separately. The single coding
generation processed 4,755 prompt tokens at 3.31 tokens/s and generated 121 tokens
at 5.21 tokens/s to request the guidance read. Host measurement rows lack PID;
native ownership evidence is retained in a separate ledger. These individual
timings and host memory samples do not establish a memory, native or deadline
cause, general stability or coding quality. The source-only four-hour budget was
not exhausted.

After cleanup, the independently reviewed [five-path default-page change](../.cache/coding-reliability/cli-context-budget-fix-v1/applied-v2-record.json),
SHA-256 `3fed59acc6345c89a0ddcb723d965bca15808797dfd41487dcac57e724c29ecb`,
was applied at 15:29:03 UTC. The host now supplies a separately validated
`LOCAL_AGENT_FILE_READ_DEFAULT_CHARS` for text `read_file` calls that omit
`max_chars`: 1,024 Unicode source characters at 8K context. Its context-derived
default is bounded by the existing host result limit. Explicit `max_chars`
requests keep their previous validation/hard cap; missing new configuration
preserves direct-sidecar legacy behavior and invalid configuration blocks startup.

The legacy `LOCAL_AGENT_TOOL_RESULT_CHARS`, `result_chars` and serialized
`readback.py` receipt-envelope cap are unchanged. PDF, web/search, native math,
gateway admission, full user goal, frozen criteria, approvals, memory/ownership
guards and time budgets are unchanged. Smaller default text pages do not grant
full-file receipts: those still need an actual complete matching read and normal
inference delivery. The normal native context guard remains authoritative; a
smaller page alone does not prove a continuation will fit or a task will finish.

Actual checks passed: 154 Python tests, all 879 Node tests with zero skips,
TypeScript and native resource verification. The research sidecar was rebuilt
once. Two actual Goose/rebuilt frozen-sidecar integration tests passed using an
authenticated fixture provider, checking default versus explicit paging and
real readback delivery. Those integrations ran no LLM or native inference and
confer no coding qualification. The [check record](../.cache/coding-reliability/cli-context-budget-fix-v1/check-status.json)
preserves consumed real exits and its prelaunch statement that fresh native
continuation was then untested. The subsequent real trial is recorded below;
that historical check record is unchanged.

The preserved 879 [ZIP](../.cache/coding-reliability/packages/Free-Local-Agent-0.5.0-alpha.1-mac-arm64-be0f01f5c396.zip)
is 229,536,533 bytes, SHA-256
`be0f01f5c396118cfcce4171e6e8b2f06fff302e524f19142f43d2257a4f31c6`.
Offline package and smoke passed; [artifact provenance](../.cache/coding-reliability/cli-context-budget-fix-v1/package-artifact.json)
records consumed exit 0. The prior e354 877 ZIP was hash-verified and preserved by
rename, alongside all older archives. The checked app (PID 33889) was reopened
and the Desktop shortcut verified. Locked interactive GUI behavior remains
unverified, and smoke loaded no model. At this 15:34 package checkpoint the
fresh native CLI result was still pending. The distinct e7b4 trial subsequently
ran a real command after compaction, then ended blocked before final model
completion, as recorded next. The final matched 108-case/117-phase comparison
remains required. All app/model inference stays free and local, with public
networking disabled for coding tests.

## 879-source CLI: verification passed, agent task blocked (15 October, 18:10 UTC)

The distinct fresh source-only [run e7b49745](../.cache/coding-reliability/qwen80-e7b4-terminal-snapshot-v1/report.json)
ended at 18:10:41.452 UTC, real exit 1, **0/1 case passed**. Task
`f36e9058-63c8-4029-9ba6-ecd244aacbb1` ended blocked/incomplete with
`verification:passed`: all five acceptance rows and all five independent row
groups passed. Task, case and whole-run `passed` stayed false; qualification,
false verification and replay stayed false/zero. A finalized failed case row is
not a completed agent task. The task used 8,627,250 active ms (143.7875 minutes);
the separate case field is 8,627,251 ms. Counts are one preparation, five
execution generations, no finalization generation and no returned continuations.
The original four-hour diagnostic budget was not exhausted.

The actual frozen V1 goal, three planned criteria, original command and protected
files were preserved. The agent wrote `stats.mjs` through the normal approval
host: 1,075 bytes, SHA-256
`82f444e71b5666ebb3836fd7d95810ce2a9c922bd5f3cdad1441bf5625ef4400`.
It also made complete ordinary path-only reads of the 529-byte `check.mjs` and
18-byte `package.json`, without `max_chars`, truncation or continuation cursors.
Both ASCII files fit the new 1,024-character default, old 4,000-character cap and
absent-environment legacy behavior. The runtime environment was not retained;
1,024 is a static source-policy inference here. These reads exercise no page
boundary or controlled paging benefit. They are different from aa7b's partial
4,000-byte read of an 8,644-byte guidance file; content and request history differ.

After the first populated exact-history compaction, native task 1268 completed
5,684 input tokens and 29 output tokens, generating
`run_verification {check_id:"cmd_check"}`, not a final answer. Its individual
prompt/decode timings were 3.18/4.95 tokens/s; these are not general task rates.
The normal approval host bound that call to exactly
`'/opt/homebrew/Cellar/node/26.7.0/bin/node' check.mjs`, cwd `'.'`, with
local-only networking. Action `cc6004b5-6bf6-4fdd-a78b-161871a92f5a`
completed at 18:10:34.370 UTC with exit 0 and saved `fixture checks passed\n`;
the Goose tool completion followed at .372. The next retained request has the
exact adjacent call/result pair, including the full host action receipt and output.

The passing evidence is bounded. Five acceptance rows comprise one actual
command result, two frozen file-preservation criteria and two additional host
safeguards for those same files. The visible command checks five input samples.
The separate saved independent verifier checks eight samples: three valid cases
(including negative values and the empty array) and five invalid cases. It also
asserts empty stdout on rejection. The five independent row groups are two
immutable-file checks, this behavior suite, actual requested-command receipts
and no implementation replay. The host recorded `INDEPENDENT_CHECK_PASSED`;
no separate per-sample raw output archive is retained. These finite fixed samples
do not exhaust arbitrary inputs, parsed nonfinite values or exponent overflow,
and passing them does not turn a blocked agent task into a pass.

The next provider log contains only input and HTTP 400 `InferenceBudgetError`:
the exact current request, tool definitions and pending/latest exchanges exceeded
context even with archived closed history. It contains no generated data, usage
or normal final model turn. The host closing truthfully says `Task blocked`
while retaining the passing checks and completed changes. The optional top-level
error key is absent; the task error is explicit. The source gives the error
priority over verification when freezing the task outcome. No claim that the
command receipt alone caused overflow follows from these records.

The final recovery archive contains two immutable parts with four exact older
closed pairs (three list/read exchanges and the prior write), eight messages and
one independent closed-write receipt. The original 4,558-byte first part is
unchanged; the second is 3,332 bytes. Manifest plus populated parts total 8,124
bytes, below 8 MiB; 38 unused placeholders remain exact. Entry IDs, index lines,
call IDs, arguments, results and part hashes match retained original history.
The latest command pair is not archived. Source reconstruction retains the full
system/user request, a 2,493-byte exact-history pointer and the latest command
pair. The final compacted HTTP body and exact private count are not saved. One
real post-first-compaction generation is demonstrated, but no archive-file read
or model attention/read-through is proven; the later request was rejected.

The completed [raw/context review](../.cache/coding-reliability/qwen80-e7b4-terminal-audit-v1/CHILD-RAW-CONTEXT-REVIEW.txt)
and [final independent audit](../.cache/coding-reliability/qwen80-e7b4-terminal-audit-v1/FINAL-REVIEW.txt)
retain these distinctions. Terminal report SHA-256 is
`243501ba9637a0dcf92f4cb67a8a6f8a3ed32a55109d72b76f651bae9b0426f7`.
All 87 source files, 624 non-weight resources, 18 native identities and 32 SSD
resource records matched the final e7b runtime binding
`f56f713f5fee4f3f3597ccc60123a085ec3626129fb6b5239843f380a4267e3d`.
The prelaunch document matched its separate recorded identity, SHA-256
`b81bed025afeee1ad9905027d70848ba442c0daea59f2edd0bbaa625a7b173fd`.
These are the pre-pointer-change e7b audit identities. The stored/current report
copies matched; no model weights or package were
rehashed by that audit. Native computation and the representative-expert/
two-hybrid-layer certificate stayed unchanged, without full 48-layer parity.

The event stream contains 4,353 distinct normal-pressure measurement timestamps:
4,351 positive RSS/footprint samples and two startup readings missing or
nonpositive. Peak RSS was 4,865,130,496 bytes, peak footprint 4,818,325,632 and
minimum host-available memory 6,316,130,304 bytes. Host rows lack PID; native
ownership is separately recorded. These are runtime-event samples, not the
separate global observer, isolated model memory demand or stability proof. No
memory, deadline or native-arithmetic cause is established by this host context
failure. All three task cleanup outcomes fulfilled. Root consumed exec 35822
exit 1 and confirmed controller 35440/native worker 35476 absent, with no native
or validation workers, at 18:13:29.319973 UTC.

This failed result does not relabel aa7b, 17ac, the original 80B 0/2 or the genuine
80fb exact-file pass. Requested Qwen/Muse totals remain 36 terminal attempts,
26 cases, nine completed tasks (five Qwen/four Muse), zero qualifications; no
cohorts are pooled. The checked 879 software and be0 package evidence remain
preserved as historical evidence. The subsequent reviewed lossless pointer
change, software checks and new package are recorded next; they supply no new
model result. The matched slow 108-case/117-phase comparison, GUI task proof,
broader coding reliability and full numerical equivalence remain unestablished.

## Lossless host recovery-pointer change (15 October, 18:28–18:33 UTC)

After the failed e7b trial and completed audits, the reviewed
[two-path change](../.cache/coding-reliability/completion-context-review-v1/applied-record.json),
SHA-256 `94c628d6ba845bc96a0f544649305448f993e49eb1ee9f2dc4e00d292c57dbfc`,
was applied at 18:28:39 UTC. It changes only the host recovery-location
representation and its tests. Repeated immutable part identities share one
full path/SHA table entry; ordered locations still retain each original part,
line and call ID. The current-part marker, safety prefix and independent-receipt
suffix remain exact. The legacy four-location/four-receipt selection and 4,096-byte
bound run before formatting; saved bytes admit no additional locations or
receipts. Compact form is selected only when its actual UTF-8 bytes are fewer.

Partition eligibility, immutable archive bytes and grants, full original user
request, latest tool call/result, schema, approvals, receipts and replay checks
are unchanged. Native input counting, output reserve, 64-token context margin,
memory guards, computation, step/repair caps and deadlines are unchanged. The
formatter's module export adds no tool or service API. A new source/resource
binding is required for a future run; the old e7b binding is historical evidence.

The [pure formatter reconstruction](../.cache/coding-reliability/completion-context-review-v1/actual-formatter-reconstruction-check.json)
used the old source-reconstructed final pointer: 2,493 to 1,974 bytes, a 519-byte
reduction, with every selected location identity/order, safety prefix and receipt
suffix exact. This is an offline byte comparison, not a saved model-bound HTTP
request, measured native token saving, prompt-fit proof or controlled coding
benefit. The real native context guard still decides admission.

The focused inference suite passed 46 checks with no skips. Initial TypeScript
checking exited 2 on union narrowing for path/SHA access; that failure is retained.
The reviewed [type-only amendment](../.cache/coding-reliability/completion-context-review-v1/type-narrowing-applied-record.json),
SHA-256 `5de45765b8b6e9fcd7c400c6984f6c7d12bdac21df3a5bde7f0ef523afef89f4`,
was applied at 18:30:03 UTC without changing runtime formatting or pointer bytes.
Final TypeScript and all 882 Node checks passed with zero skips; their real exits
were consumed. The existing 154 Python/rebuilt-research evidence is retained,
not newly rerun or rebuilt for this pointer-only change. Tests cover identity,
order, selection bounds, fallback and real approved action fixtures with mocked
native counts. Those checks establish no actual native fit or model completion.
The [check record](../.cache/coding-reliability/completion-context-review-v1/check-status.json)
retains both the initial type failure and final success.

The checked 882 [ZIP](../release/Free-Local-Agent-0.5.0-alpha.1-mac-arm64.zip)
is 229,537,076 bytes, SHA-256
`c8e37a05bc71feddf8b7e98cd1d1d7450df8a517ffa4524339b8dfb860feee64`.
[Artifact provenance](../.cache/coding-reliability/completion-context-review-v1/package-artifact.json)
records consumed package exec 50349 exit 0 and smoke exec 28784 exit 0. The old
879 be0 ZIP was hash-verified and preserved by rename at its separate archive
path; its bytes and prior e7b evidence are unchanged. Its owned GUI PID 33889 was
stopped and confirmed absent for packaging. The exact checked release app was
reopened at 18:33:24 UTC as PID 63329, with the Desktop shortcut verified.
Locked interactive GUI task behavior remains unverified; package, smoke and
reopening loaded no model.

A new isolated native CLI trial on the checked pointer change subsequently
failed 0/1 at **22:06:16.308 UTC on 15 October**. Run
`1c352802-4264-4193-af2a-6d08e038fe21` remained blocked/incomplete/UNVERIFIED
after 12,215,042 active ms, one preparation and seven execution generations,
zero finalization generations or returned continuations. It performed no
implementation, write, effect, approval or requested command, and produced no
normal final model end_turn; `stats.mjs` retained its 48-byte scaffold. Four
preservation acceptance checks passed and `check-cmd` remained unverified;
independent behavior and requested-command receipt checks failed. False
verification and replay remained zero, qualification false. Its context-admission
error occurred before exhaustion of the original four-hour budget.

The [terminal review](../.cache/coding-reliability/qwen80-pointer882-terminal-audit-v1/FINAL-REVIEW.txt)
preserves the final ordinary 529-byte `check.mjs` read, the next rejected context
request, and four populated archive parts despite only three successful stage
notices. The fourth append preceded failed native-count admission; it was not a
fourth successful generation. The final frozen-source reconstruction selected
the legacy pointer because its 1,132-byte location array was smaller than the
1,189-byte candidate wrapper. Earlier serialization reductions are not measured
token savings or a controlled coding benefit. No archive-file readthrough,
final prepared wire or model attention is established. Profile and final binding
were stable, runtime error null, and all three cleanup entries fulfilled;
owned workers were positively absent and real exec 1373 was consumed once with
exit 1. Its [immutable report](../.cache/coding-reliability/qwen80-pointer882-terminal-snapshot-v1/report.json)
is 242,735 bytes, SHA-256
`aa484b046f5e570bff72418ba76687f7cf4e7def78c39b5a1595fbf705cf5ce9`.
No old task is replayed or promoted. All inference remains free/local and public
networking stays disabled for coding tests. The later matched slow result above
remains incomplete; interactive GUI task proof remains unverified.

## Other model comparisons and weaker systems

The [research report](../.cache/coding-reliability/research-large-models.md)
links publisher model cards and methodology. SWE-bench Pro original and revised
task sets, Terminal-Bench 2.0 and 2.1, competition coding, and function calling
are separate measurements. Published scores describe upstream models and their
publisher scaffolds, not these exact Q3 files, 16K local context, this controller
or this Mac. The original 4B 12/36 baseline remains separate from any fresh
current-controller 4B/9B/80B comparison. No controlled local comparison or
equivalence to Sonnet/GPT is claimed.

The official Apache-2.0 Qwen3-Coder-Next 80B Q4 acquisition uses four pinned shards
totaling 48,410,992,032 bytes (45.09 GiB). Acquisition is complete: the owned
downloader exited zero after verifying every exact publisher SHA-256, the full
GGUF split set and the actual native template. The
[completion manifest](../.cache/coding-reliability/large-models/downloads.json)
records `kind: verified-local-large-model-download`, `complete:true` and actual
template SHA-256
`0b5c439b5b14126c0ae8b14ca93240c3cef1e7e29d684102b07f10727523dbdb`.
The [saved transfer log](../.cache/coding-reliability/download-large-model.log)
contains `LARGE_MODEL_DOWNLOAD_COMPLETE`; its owned downloader and keep-awake
process have ended. This report reads saved verification records and matching
ordinary-file sizes, without rehashing weights.

Acquisition alone establishes neither native readiness nor coding qualification.
Its download manifest intentionally retains `nativeReadiness:false` and
`codingQualification:false`; later scoped numerical proof and the failed full-model
source diagnostic are recorded separately above. The earlier private 4K fixture
is historical. The current 8K route is applied and partially numerically certified.
One fresh source-only 80B exact-file task has now completed with actual repair,
readback and independent checks; its completed joined review found no scoped
acceptance blocker. The first subsequent CLI case failed before coding on host
context admission. The separate 879-source CLI later wrote code and ran the
approved command with passing bounded checks, then ended blocked after another
context rejection. No 80B CLI task pass, matched benchmark result or broad coding
qualification is established. The base
readback/four-hour route passed its 866 checks; the later prompt amendment passed
870 checks and built/smoke-tested its package. Both requested-model exact-file
pilots completed on 870; the first full 80B four-hour exact-file trial failed
0/1, while the distinct fresh 877-source exact-file trial later passed 1/1.
The post-failure diagnostic feedback change passed 51 focused checks, all 877
Node checks, TypeScript and resource verification, followed by offline package
and smoke. The successful selected case is not a controlled measurement of that
change, full 48-layer numerical equivalence, four-hour stability or GUI proof.
The 879 software/integration/package checks passed. Its later real CLI generated
a verification call after the first populated compaction and ran the approved
command successfully, but the next request failed context admission. The task
remains blocked, with verification passed and no final model completion. The
matched slow comparison and GUI task proof remain required. The subsequent
pointer-only host change passed its 882 software/package checks, but its distinct
native CLI trial failed on context admission without implementation or completion.
Its result is retained above and establishes no controlled pointer benefit.

Apple CPU and Metal share physical RAM. Moving more tensors to CPU can reduce
GPU residency and run more slowly, but does not add RAM. Smaller models, lower
quantization, smaller KV caches, one slot and smaller batches can reduce demand;
quantization and context reductions can affect task quality. Dense models touch
most weights each token, whereas exact MoE expert streaming can fetch a subset.
The 80B model has about 3B active parameters per token, but its complete stored
weights still occupy 45.09 GiB. A 24-GiB implementation must demonstrate bounded
resident expert cache, workspace, mappings and operating-system reserve with
normal memory guards, numerical parity and real task receipts. Extra time alone
does not guarantee correctness, and unverified SSD prototypes do not establish
app readiness.

The research follow-up distinguishes Apple's predictor-based sparse experiments
from exact MoE streaming. It also separates original Qwen80 author-reported
throughput from a faster pruned variant and notes the Qwen-specific C/Metal port's
unproven real generation/parity. None supplies this app with a readiness or coding
qualification result. [Primary-source SSD follow-up](../.cache/coding-reliability/research-large-models.md#additional-ssd-evidence-checked-on-14-october).

The report generator takes bounded snapshots of ordinary evidence files, ignores
incomplete active JSON/log lines, and checks known file sizes/hardlink identities.
It never rehashes weights, runs a model, executes evidence commands or requests
network access. Refresh the self-contained printable HTML and adjacent JSON with
`node scripts/generate-local-model-report.ts` after terminal reports are written.
