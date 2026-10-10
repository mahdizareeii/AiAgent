# Working details and workspace folders

Free Local Agent **0.4.0-alpha.2**, validated on 2026-10-10 on macOS arm64.

## Behavior

Click **Working** to expand the current reply's model thinking, stage, and tool
activity. Completed thinking is shown in a collapsed **Thinking** disclosure.
The app displays only text supplied by the model; a model without thought output
shows an explicit unavailable message. Tool details retain their specific names
when a later update has only a generic title.

Thoughts and answers use separate fields throughout native inference, Goose ACP,
IPC, rendering, and storage. Thoughts are limited to 64 KiB of UTF-8 per reply,
preserving whole characters, and survive completion, cancellation, errors, and
chat reopening. They are excluded from subsequent conversation prompts and
compaction. Tool/stage activity is current-run UI state and is not restored when
reopening a task.

Compatible native templates now use automatic thinking detection and extract
thoughts into `reasoning_content`. A reasoning token budget of half the profile's
output allowance, capped at 1024 tokens, leaves output capacity for the answer or
tool call. Calibration, speed measurement, summaries, and compaction explicitly
disable thinking. No second inference request manufactures thought text.

**Add folder** opens an existing workspace through the native picker. **Create
folder** asks for a portable single-component name, then opens a native parent
picker. Creation never overwrites an existing entry. The host verifies canonical
paths and directory identities, saves the selection, then grants access only to
the child. Cancellation does not change the selection or grants. A failed save
restores the previous selection and leaves the newly created folder untouched.
Saved tasks keep their original folder; start **New task** to choose another.
Folder dialogs and pending saves block new tasks and capability changes.

## Checks

| Check | Recorded result |
| --- | --- |
| Strict TypeScript and production build | Passed |
| Full app/runtime suite | **141/141 passed**, no skips; public networking denied and localhost allowed |
| Workspace tests included in suite | Native-picker cancellation, existing-entry refusal, portable name/path validation, canonical selection, directory races, persistence recovery, and child-only grants passed |
| Thought tests included in suite | UTF-8 bounds, saved-state compatibility, partial thoughts, native reasoning flags and recovery budgets, auxiliary nonthinking requests, authenticated gateway separation, and actual Goose ACP thought streaming passed |
| Additional temporary renderer fixture | **12/12 scenario groups passed**, separate from the 141-test count |
| Renderer coverage | Click expansion, disclosure focusability, actual thought/tool/stage separation, specific tool titles, completion/stop/error/reload, no-thought fallback, Add/Create validation and cancellation, failed and pending creation, draft/attachment preservation, and setting/task locks |
| Real Qwen3.5 4B native run | Passed through the production local runtime, token gateway, and source-built Goose with external networking denied; separate thoughts and final answer verified |
| macOS arm64 package and final smoke | Passed; bundled pins/manifests, ASAR action bridge, denied write, skill asset, and MCP mode/web boundaries verified |
| Native visible workspace | New package launched successfully in a separate profile; actual workspace captured with Add/Create controls and Research off |
| Native thinking-keyboard activation and full folder flow | Not verified visibly; the user began using the preview window, so automation did not continue against their active work |
| Windows/Linux native execution | Pending |
| GitHub publication | Kept local at the user's request; no push performed |

The temporary renderer uses synthetic IPC and an isolated profile, without a model
or native screenshots. Native `<details>/<summary>` focusability and click
expansion passed; hidden Electron did not activate the summary on keyboard
dispatch, so visible Enter/Space activation remains pending. Tests do not replace
complete project-quality or operating-system permission validation.

The packaged smoke loads no model or public web tool. Network-denial proof applies
to native/model/protocol tests and the full suite, not the normal GUI launch or
renderer fixture. Research-sidecar Python source and binary were unchanged;
earlier Python/protocol counts remain historical in the
[research validation record](task-research-validation.md).

## Real local model evidence

The existing pinned Qwen3.5 4B artifact was reused without downloading weights or
modifying the normal app profile. The final smoke used an isolated hardlinked
copy on an Apple M5 with 24 GiB RAM. It used Slow mode with Metal, 8192 context
tokens, 2048 output allowance, batch 256, microbatch 64, and 1024 reasoning tokens.

The model answered a simple multiplication request with exactly **391**, emitted
**369 characters / 372 UTF-8 bytes** of separately routed thoughts, and called no
tools. Its short nonthinking calibration measured **36.80 tokens/sec**. All owned
native smoke processes stopped afterward. This is a short routing check, not a
coding benchmark, broad latency distribution, or peak-memory measurement.

Model SHA-256: `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.

## Native screenshot and artifact

![Actual 0.4.0-alpha.2 workspace](screenshots/free-local-agent-workspace.png)

The screenshot shows the actual packaged workspace before model selection,
without user chats or fabricated responses. The initial restricted GUI launch
aborted; launching outside the execution sandbox in a separate profile succeeded.
Desktop capture then succeeded, resolving the earlier capture limitation for
this initial screen. Later actions stopped when the user began interacting with
the preview. That preview's data folder is separate from the regular retained
`Local Agent` store and is preserved.

Archive: `release/workspace-actions/Free Local Agent-0.4.0-alpha.2-arm64-mac.zip`

- Size: **217,044,246 bytes**
- SHA-256: `41bc84b895517048dc3032ffcaab44b3d0eea882f2ee3fb5058db7f3f29d4d14`
- Target: Apple Silicon, macOS 13.3 or newer; unsigned and not notarized

The previous [workspace/plugin record](workspace-plugin-validation.md) preserves
0.4.0-alpha.1 evidence and its then-blocked screenshot status.
