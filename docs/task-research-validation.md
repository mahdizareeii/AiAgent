# Task research validation — 0.3.0-alpha.2

Recorded on 2026-10-10. The app now bundles the
[task-research skill](../local-agent/desktop/skills/task-research/SKILL.md)
and loads it into Agent and Research turns. No separate skill installation or
hosted model is needed. Web research stays off by default; enabling it permits
public search and page reads in those two modes. Chat cannot register web tools.

The workflow inspects local versions and constraints, verifies changing facts
against primary documentation when online research is enabled, then continues
implementation and validation. It does not automatically upgrade dependencies,
update model weights, install app updates, or bypass action approvals.

| Check | Result |
| --- | --- |
| TypeScript and full app/runtime suite | 115/115 passed, no skips; public networking denied and localhost allowed |
| Source research-sidecar tests | 75/75 passed |
| Rebuilt frozen sidecar MCP protocol | 7/7 passed |
| Official skill validator | Passed; validator-only PyYAML stayed in ignored development cache |
| Native Goose routing | Included in the 115-test suite; bundled skill reaches provider input, Agent web opt-in works, disabled/local and read-only boundaries hold |
| Independent source review | No remaining actionable P1/P2 findings in this bounded feature |
| Native Qwen4B official research → approved file → readback | Workflow passed; strict output quality failed as detailed below |
| macOS arm64 package and packaged smoke | Built and passed with public networking denied; packaged ASAR skill, native pins, approval denial, and opt-in mode registration verified |
| Interactive GUI and Windows/Linux native execution | Not performed for this update |

The first full suite overlapped a frozen-sidecar rebuild and found its executable
temporarily missing. The recorded 115/115 result is the clean rerun after that
rebuild finished. The first package attempt could not resolve GitHub for an
Electron download; the rebuild uses the already-cached pinned Electron archive.

The test suite covers missing/malformed/oversized skill files, exact skill loading,
current-date access status, saved web preferences, Chat-only imports without
callable tools, mode/utility registration, and existing denial/undo behavior.
Research cases cover redirected final URLs versus untrusted canonical claims,
explicit/missing/conflicting/invalid source dates, publication-versus-observation
timestamps, normalized source hashes, escaped-text/metadata result budgets,
cancellation, and existing public-address and credential guards.

## Real-model evidence

One actual Qwen3.5 4B turn used the pinned artifact SHA-256
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`
on the 24 GiB Apple M5. The isolated profile explicitly enabled web research
and Slow mode, with terminal commands disabled. Inference used only the
authenticated app-owned loopback endpoint: Metal, 8192 context, 2048 output
reserve, batch 256, and microbatch 64. A short native calibration measured
22.76 tokens/sec. Setup probes stopped before the actual agent turn; no model
task was rerun and no generated file was manually repaired.

The actual tool sequence was:

1. Fetch the [official WordPress requirements](https://wordpress.org/about/requirements/).
2. Create `wordpress-research.md` through one approved `write_file`.
3. Read the file back through the granted `read_file` tool.

The successful fetch returned 1544 normalized characters, fetched at
`2026-10-10T14:49:40Z`; the page supplied no publication date. The generated
802-byte file cited that exact URL and retrieval timestamp. Its core PHP/database
requirements and legacy compatibility matched the fetched evidence. Readback
size and SHA-256 matched the real file. Complete native input counts were 3435,
4139, 4453, and 5007 tokens, including the skill and current tool exchanges.

Strict task-output quality **failed**: the note had 29 lines instead of the
requested maximum 20, and strengthened a suggested server configuration into a
mandatory `mod_rewrite` rule for Nginx/Apache. This demonstrates live research,
approved file creation, and verification; it does not establish reliable complete
project generation. No commands, WordPress installation, or site execution ran.
The generated profile did not alter user chats or settings, and all owned
inference/agent processes stopped afterward.

This real-model run used the source Python sidecar; frozen/native package checks
are separate. See the [machine-readable record](task-research-real-model.json).
Source date claims and retrieval time are evidence to evaluate, not guarantees of
latest releases. Small-model compliance and interpretation still require review.

## Distribution

Archive: `Free Local Agent-0.3.0-alpha.2-arm64-mac.zip`, **217,037,564 bytes**,
SHA-256 `2e645d833c01123df7815df4648c9ab7e53cd48880aa169e193503ef4923e122`.
The package was built from the cached pinned Electron 43.7.8 archive. The smoke
read the exact shipped skill from ASAR using the packaged Electron, verified
native inference/Goose resources, and checked the rebuilt frozen sidecar.
Denied writes left the project unchanged. Default web tools were absent;
explicit Agent/Research web preferences registered only the expected tools,
and explicit Chat web preference still registered none. This smoke loaded no
model and made no public request; the real-model online check is recorded above.
The existing 0.3-alpha.1 model-setup image is historical evidence; no new
screenshot or full GUI workflow is claimed for this update. GitHub publication
remains blocked by the existing authentication failure; source and installer are
local. macOS packages remain unsigned and unnotarized.
