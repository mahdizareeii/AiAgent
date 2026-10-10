# Free Local Agent 0.3 update validation

This report records the **0.3.0-alpha.1** update as of **2026-10-10**. It keeps
current evidence separate from the earlier 0.2 package and its model-speed
measurements. Package metadata, packaged smoke, and both real-model task results
are recorded below. One initial model-setup screenshot provides partial GUI
evidence; full interactive GUI checks remain pending after capture-tool failure.

## Scope

- Agent, Research, and Chat labels; new tasks default to Agent.
- Workspace selection can create an empty folder for a new project.
- Agent instructions use the enabled tools to inspect, implement, and validate,
  and report concrete blockers instead of a blanket lack of capability.
- `create_files` proposes 1–20 new text files, totaling at most 512 KiB, under a
  single reviewed approval. Existing files are never replaced by this tool.
  Parent creation, stale previews, cancellation, and grouped undo are covered
  by focused checks.
- PHP and PHTML are included in local reading/search support.
- Light porcelain/cobalt/violet theme and a persisted dark-theme toggle.

## Evidence received so far

| Check | Status |
| --- | --- |
| Full JavaScript/TypeScript suite | 106/106 passed with no skips; public network denied and localhost allowed |
| Research tests | 61/61 passed |
| Rebuilt frozen research sidecar | 5/5 protocol checks passed |
| Separate temporary renderer regressions | 8/8 passed; separate from the checked-in suite count |
| Real Qwen3.5 4B complex WordPress task | Action routing passed; five approved file creations; complete scaffold failed; no site launched |
| Separate two-file minimal-theme task | Passed in one attempt: one approved batch, two file creations/readbacks, matching hashes and passing static structure checks; no PHP/WordPress execution |
| macOS 0.3 native package | Built; archive size/SHA-256 verified; packaged smoke passed with public network denied |
| Initial 0.3 model-setup screenshot | Captured; partial evidence only |
| Full visible GUI and further screenshots | Pending after stale frames / ScreenCaptureKit -3811 despite an unlocked desktop |
| Normal-config upgrade preservation | Passed; three chats/message counts, model selection, and utilities preserved; GGUF size/mtime unchanged |
| GitHub publication | Pending authentication; no push completed; current changes and installer remain local |
| Windows/Linux native execution | Pending; CI configuration alone is not native validation |

The automated suite result does not establish a finished project or substitute
for a real-model agent run. The real-model check must confirm actual files,
tool activity, approvals, and available validation outcomes. Creating project
files is distinct from installing and running a WordPress site.

## Complex real-model task result

The native Qwen3.5 4B run completed on 2026-10-10 using the pinned model SHA-256
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
On the Apple M5 with 24 GiB RAM and 7.10 GiB available memory, the Metal profile
used 8192 context, 2048 reserved output, 512 batch, and 128 microbatch tokens.
Local calibration measured **24.97 tokens/sec**. Public networking was denied
and localhost allowed. This was a native agent harness, not a visible packaged
GUI run.

The agent created five real files with five approvals and **no approved commands**:
`README.md`, `docker-compose.yml`, `sample-wordpress.txt`,
`wordpress-config/wp-config-sample.php`, and `wordpress-config/wp-config.php`.
Action routing passed, with no tool-argument truncation. The independent full
WordPress validator **failed** because the PHP bind source referred to a
directory instead of an existing file. The generated PHP configurations also
lacked the WordPress bootstrap and contained duplicate definitions. Protected
`.env` creation attempts were rejected; no protected environment file was created.

The gateway stopped the current request when **6321 input tokens + 2048 output
reserve** exceeded **8128 usable context tokens**. It did not compact active
action history or replay completed actions. Owned native processes stopped.
**The agent ran no approved terminal command; no container or WordPress site was launched.** The completed evidence
supports approved file creation and bounded failure handling, while the full
project task failed. A separate smaller task passed as recorded below.

The [machine-readable complex-task record](wordpress-agent-smoke.json) retains
file hashes, hardware/profile measurements, validation failure, and budget state.
This single task is not a broad model-quality benchmark.

## Two-file minimal-theme task result

The separate native task ran once on 2026-10-10 with the same pinned Qwen3.5 4B
model, public networking denied, and localhost allowed. On the Apple M5 with
24 GiB RAM and **7.34 GiB available memory**, it used Metal, 8192 context,
2048 reserved output, 512 batch, and 128 microbatch tokens. Native calibration
measured **38.61 tokens/sec**; it is a short measurement distinct from the complex
task's 24.97 tokens/sec result and earlier 0.2 calibrations.

One `create_files` call and one approval created:

| File | Bytes | Readback and static evidence |
| --- | --- | --- |
| `style.css` | 509 | Real readback SHA-256 matched; Theme Name header present |
| `index.php` | 644 | Real readback SHA-256 matched; WordPress loop and expected hooks present |

Both readbacks used the actual `read_file` tool, and the returned canonical
paths, sizes, and hashes matched the files on disk. The gateway counted complete
inputs of 2571, 3026, 3522, and 4042 tokens during this task. The resulting
file-creation/readback and static structure check **passed**. Owned processes
stopped afterward.

The initial harness assertion required an absolute input path and incorrectly
rejected a valid workspace-relative read. Correcting that harness assumption
verified the already-generated tool results. This was **one model attempt**;
there was no model rerun or manual repair of generated files. The
[machine-readable minimal-theme record](wordpress-theme-agent-smoke.json)
preserves the correction, hashes, and limitations.

**No PHP syntax check, WordPress execution, rendered-site check, or site launch
occurred.** The theme relies on WordPress core header/footer compatibility
fallback rather than its own complete templates. WordPress documents this
lookup in [get_header](https://developer.wordpress.org/reference/functions/get_header/)
and [locate_template](https://developer.wordpress.org/reference/functions/locate_template/);
its [core header fallback](https://github.com/WordPress/WordPress/blob/master/wp-includes/theme-compat/header.php)
is marked deprecated. The generated title is emitted without an explicit
escaping wrapper, and no comprehensive escaping/security audit ran. These are
limits on production theme quality. This narrow task pass does not establish a
working WordPress installation or broad coding competence.

## Packaged smoke

The final 0.3 macOS packaged smoke passed with external networking denied and
localhost allowed. It verified the native engine and offline Goose pins, frozen
sidecar MCP tools, and packaged Electron/ASAR action host. A denied write kept
the project unchanged, and web tools were absent by default. The smoke does not
load a real model or establish a completed visible GUI run.

Current macOS archive: `Free Local Agent-0.3.0-alpha.1-arm64-mac.zip`,
**217,016,826 bytes**, SHA-256
`1c7bcd949570fb05b451201daa37f504b2a97b4ab3dfd2122eff60ac3dc2d3e7`.

## Partial GUI and upgrade evidence

The [actual initial 0.3 model setup](screenshots/free-local-agent-models.png)
shows the M5 hardware assessment, 24 GB system RAM, and 3.8 GB available during
another native validation run. It is the only retained capture. The home,
conversation, and tool captures were not completed and their missing image
embeds were removed from README. The screenshot came from an isolated validation
profile and contains no user chat data.

The user confirmed the Mac was unlocked. UI controls updated, but screen pixels
were stale and clicks could not obtain a fresh frame; the last native error was
`ScreenCaptureKit SCStreamErrorDomain -3811` (audio/video capture failure).
Temporary GPU/background launch diagnostics did not restore capture. The shipped
app retains normal GPU configuration, and full interactive GUI validation is
still pending. Native agent results and packaged smoke remain separate evidence.
The capture error alone does not establish a graphics root cause.

The updated app opened normally with its retained legacy data store. A
content-free check confirmed all three saved chat identities and message counts,
selected model, and utility preferences were preserved. The local pinned GGUF
remained **2,740,937,888 bytes** with unchanged modification time and was not
downloaded again. This report includes no private chat IDs, message contents,
or user-data paths. The preservation result does not establish a complete GUI
or a new packaged inference run. GitHub publication is pending authentication;
no push completed, and the source changes and installer are local.

## Earlier model evidence

On the 24 GB Apple M5, earlier 0.2 Qwen3.5 4B native chat, tool calling, token
counting, and Goose/MCP file reading passed. Short native and earlier packaged
calibrations measured 30.8–37.5 tokens/sec. These are historical short-run
measurements, not a speed measurement of the 0.3 package, broad coding-quality
benchmark, or measured peak memory. See the
[compatibility report](compatibility-report.md) and
[earlier verification report](build-verification.md).

## Final evidence to record

```text
Date / source revision:
Final archive filename / bytes / SHA-256:
Final TypeScript, JavaScript, research and packaged-smoke results:
Real-model artifact hash / backend / context / enabled tools:
User request / workspace / approvals and denials:
Files actually created / checks actually run / observed blockers:
Whether a WordPress site was installed and started:
Fresh screenshot paths / GUI observations:
```

The application remains an unsigned macOS alpha. Broader model task quality,
peak memory, long-context behavior, and Windows/Linux native checks remain
outside the evidence recorded here. The local model can make mistakes, and
tool access does not establish Codex-equivalent task performance.
