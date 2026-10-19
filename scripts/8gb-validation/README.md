# Whole-OS 8 GB validation v1

This is a new evidence protocol. It does not amend, rerun, replace, or promote
the existing qualification and slow-system protocols or their historical reports.
All macOS arm64, Linux x64, and Windows x64 CPU combinations remain **unverified**.
No real 8 GB system or whole-OS 8 GB VM has been tested by this change.

`node scripts/8gb-validation/run.ts --describe` prints the frozen v1 request/check
specification and its digest. `--evaluate REFERENCE.json CANDIDATE.json` reads
existing bounded local reports and checks the decision rule. It performs no
inference, downloads, network operations, fixture modifications, or report writes.
Its result always keeps legacy `qualified` and `supportClaimEstablished` false.
Evidence fields and retained paths are claims to be independently checked, not
self-authenticating proof that an oracle or sampler ran.

`--verify-fixture ID WORKSPACE NEW_PRIVATE_ORACLE_DIRECTORY PYTHON` executes the
frozen independent filesystem/behavior oracle on an already-produced workspace,
preserves protected scaffolds, and writes its oracle outside the workspace. It
uses the existing OS-level no-network command launcher and fails closed on
unsupported platforms; it never runs a model or substitutes operator-created
code for a measured model implementation. Its success alone does not establish
the model's required readback/command/approval receipts or task completion.

## Frozen comparison

- Same source/resource/engine binding, OS identity and whole-OS hardware evidence.
- Fresh Qwen3.5 4B Q4_K_M reference and one separately pinned 9B candidate.
- Exact CPU 4096-context/1024-output, batch64/micro16, F16 KV, one-slot profile.
  Native loading uses no GPU, no operation offload, no repack, four decode and
  four batch threads, disabled checkpoints and flash attention. Request/criteria,
  permission, replay, command, delivery and finalization gates remain intact.
- All twelve frozen specifications, three repetitions each. Ten quality cases
  produce30 scored rows; every safety repetition must pass. No partial resume,
  candidate skip, task budget extension, oracle edits or false completion/replay.
- At least five percentage points more quality passes than the fresh reference.
- Exactly one cold and one warm short-answer acceptance prompt must each finish
  within300seconds, including verified-artifact checks and preparation. Retain
  request, verification, preparation and completion timestamps plus the exact
  answer; decoding-only latency is insufficient. There is no invented minimum
  workload duration or generated-token/continuation count. Full memory samples
  run continuously from preparation through owned final drain, retaining actual
  PID/parent identities while the child exists, gaps no greater than2.5seconds,
  normal pressure and at least1GiB available memory. Each quality/safety prompt
  also has a frozen five-minute budget; do not extend a failed attempt.
- The exact CPU allocation plan must fit total RAM after the unchanged OS reserve
  (at least3GiB or20%, whichever is larger). RSS and macOS physical footprint
  overlap: use their maximum. Windows private commit and Linux swapped pages
  remain separate diagnostics. Disk, swap and VRAM do not extend the CPU budget.
- Installed whole-OS capacity must be8,000,000,000 through8GiB; process/cgroup
  limits on a larger-memory host cannot establish8GB support. Physical systems
  and whole-OS VMs are explicitly distinguished. Other accelerators, OS versions,
  CPUs and quantizations inherit no evidence.

## Real Electron adapter and remaining execution evidence

`electron-runner.mjs` is an external Node driver for the actual built Electron
main, real preload and renderer. It does not replace the provider, bridge,
inference, runtime status, approval registry, outcome or oracle results. The
native folder/model picker returns only a queued driver-owned fixture path.
The scored suite has twelve concrete assets (including six-job dependency and
weighted-tardiness reasoning), three repetitions each, with independent programs
outside granted workspaces. Two separate unscored real tasks exercise background
conversation navigation, owner-bound approvals, rejected concurrent Send/Undo,
scoped Undo after drain, and an actual owner-bound renderer Stop from another
conversation while a real approval is pending. Actual mouseDown/mouseUp events follow an elementFromPoint hit test; the driver
uses the approval's Browse control before switching conversations, then the
background owner Open/Stop controls. No programmatic HTMLElement.click bypasses
the modal overlay or substitutes a projected task/approval.

A safe host-only check is:

```sh
node scripts/8gb-validation/electron-runner.mjs --preflight-only
```

The actual24GiB host was rejected before app/model loading. On an8GB target the
preflight also executes a local no-network policy availability check, without a
model or public-network request. Linux/Windows currently fail before inference
because their OS-enforced command/oracle network-denial adapter is missing.
Their pinned CPU planner/monitoring code does not by itself remove this blocker.
This driver presently requires OS-reported capacity8,000,000,000..8GiB; it has no
separate installed-versus-usable-memory probe for a smaller visible total.

After code/package freeze, ordinary guest setup and explicit authorized launch:

```sh
/path/to/standalone/node scripts/8gb-validation/electron-runner.mjs --execute \
  --environment whole-os-vm --hardware-evidence /private/run/hardware.json \
  --models-dir /Volumes/fixtures/models --app /Volumes/fixtures/app.asar \
  --electron '/Volumes/fixtures/Electron.app/Contents/MacOS/Electron' \
  --python /Volumes/fixtures/tools/python/bin/python3.13 \
  --tools-root /Volumes/fixtures/tools --out /private/run/NEW-directory
```

The hardware JSON declares `environment`, `memoryScope:"whole-os"` and a human
`description`; it cannot override actual OS RAM. Node/Python must be real standalone
executables inside the dedicated tools root. New output/profile directories and
an exclusive local driver lock prevent reuse/resume. Source, suite, dist/app ASAR,
resources, the standalone Electron.app shell and tools tree are bound before model work and checked
again after each whole-model drain. The standalone shell must contain default_app.asar and no app.asar, so it executes
the external bootstrap rather than auto-starting the packaged app. Internal standalone-tool/Electron-framework symlinks are recorded
and must resolve inside their respective bound tree; app/source symlinks fail closed. Model
weights are verified by the actual app import inside cold latency, and are never
operator-rehashed by the source/resource inventory.

SIGINT, SIGTERM and SIGHUP retain the first interruption and request the existing
owned IPC Stop. The parent keeps its observers, drain and report writes alive,
records interruption evidence and starts no further candidate; its intended exit
is130,143 or129 respectively. Repeated signals do not repeat the request. A nonce
authenticated early Stop is latched before the production main can import, and
the child retains its parent-disconnect cleanup. An external execution wrapper
must still retain the actual outer Node exit; a recorded intended exit is not that
independent observation. These mechanics are tested with detached Node stubs,
not Electron/model execution or an8GB gate override.

Cold/warm latency keeps the raw answer and explicitly trims only surrounding
whitespace to compare42. Preparation timestamps are actual ready-status
observations, not invented native preparation instants. All request timing includes
verification/preparation and the cold clock includes plan persistence/app startup.
Continuous Mac RSS/physical-footprint samples come from the actual pinned helper,
called by the owning Electron parent, with fresh PID/parent joins. Raw host/native
events are appended linewise under a hard bound; retained transition indexes do
not replace that raw stream. No hidden prepared HTTP/token wire or model attention
is claimed. A normal real `TaskOutcome.finishReason` and full owned drain remain
required. Incomplete/error runs, missing controls, bad controller exits and partial
case matrices cannot become eligible comparisons.

Command scoring joins the actual flat ACP receipt, pending call input or exact
command digest, local-only policy and durable identity. The network fixture approves
only its fixed bounded fetch, then requires an observed actual sandbox launch and
nonzero local-only receipt; a denied approval alone cannot prove OS network denial.
Derived file tasks check ordinary full successful postimage reads against fresh
file bytes. They do not inherit the literal exact-file task's stronger V2 native
readback receipt. Independent oracle processes use the production no-network
launcher and proxy-environment scrubber. This is network isolation, not a claim of
filesystem isolation for generated programs. Protected files are checked before
and after oracle drain; model-generated modules are observed in bounded children
before trusted outer assertions.

The highest-quality fully eligible candidate is ranked first; equal quality uses
the measured cold/warm mean latency, then measured peak owned residency, then a
stable model-ID tie. Recommendation is only for independent raw review. Actual
whole-OS model runs, the full36 rows per model, latency/resource evidence and raw
independent review have **not** been completed. Every platform/quantization remains
unverified; synthetic mechanics tests and this executable adapter establish no8GB
support, general reliability or cloud equivalence.

## Primary artifact provenance

All three Unsloth Qwen3.5 9B artifacts use immutable repository revision
`3885219b6810b007914f3a7950a8d1b469d598a5`. Primary Hugging Face LFS
[metadata](https://huggingface.co/api/models/unsloth/Qwen3.5-9B-GGUF?blobs=true)
was checked on2026-10-17 and returned that exact repository revision together
with the three sizes and hashes below. No model weight payload was downloaded
in that initial metadata-pinning step. All three artifacts were subsequently
acquired and verified; `.cache/8gb-validation/models/acquisition.json` retains
that acquisition receipt. Acquisition establishes no model readiness, latency,
task quality or8GB support.
The revision-specific endpoint could not be fetched in this environment; the
successful primary response's explicit revision is the provenance for these pins.

| Quantization | Bytes | LFS SHA-256 |
| --- | ---: | --- |
| Q3_K_S | 4316865760 | `162050d39ebae6b8a87435f282bcb7a0e3fab7b2444db730966b3fef1ed0179e` |
| UD-IQ3_XXS | 4016235744 | `40d0f32cd3030b04f0784139a589fb63e876cfbf8667d56311b79783c74fd149` |
| UD-IQ2_M | 3649365216 | `a31b6b4c603ddd66b5496ee065c9dd13b2b6de77dce9e5d59609aef8d39868e7` |

Linux counter semantics follow the primary
[kernel proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html):
MemAvailable estimates reclaimable headroom; smaps_rollup supplies the precise
resident snapshot. PSI stall thresholds are explicit app policy, not a kernel
normal/warning/critical enumeration. On Windows,
[Win32_OperatingSystem](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem)
provides visible/free physical memory, and
[Process.WorkingSet64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.workingset64)
provides the resident working set. The Windows pressure classification uses
explicit headroom/commit thresholds and is not labeled a native OS pressure enum.

Synthetic policy/parser tests establish none of the required real execution,
memory stability, quality, native UI or platform-support evidence.
