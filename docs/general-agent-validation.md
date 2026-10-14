# General agent and setup validation

Date: **2026-10-11**. App version: **0.4.0-alpha.3**. Delivery remains local.

This update improves the general local agent. WordPress is an acceptance task,
not a dedicated feature, prompt, template, or tool. The app still runs bundled
llama.cpp and Goose locally, with the existing approval boundary for edits and
commands.

The native WordPress acceptance example **passed all 12 independent checks**
on R11 at **2026-10-11 10:53:55 UTC**. The real app used guided separate tasks
and normal approvals to create, repair, start, and install the project.
Configuration, DB health, installed core/version, expected title, homepage
HTTP 200, administration login HTTP 200, and resolved official ARM64 images
were verified. The [sanitized acceptance record](wordpress-native-acceptance.json)
binds this result to the exact R11 app and backend checksums. The verifier
performed five authorized cached read-only CLI one-shots and made no setup
mutation. Installation ran once. Its normally approved postcheck exited 0,
and the install turn finalized with five saved tools and 1,433 thinking bytes.

The installation emitted an upload-directory permission warning. A later R12
app task created the dated uploads directory as the web user and created
the handoff; independent read-only checks
confirmed both uploads directories writable as `www-data`. Browser media
upload was not tested. The R12 general-file check then applied one exact
approved correction, and independent readback found `Local agents can build
tools.` with SHA-256 `f6bdd21ecd9728d3da5d9d1a070dba34d204524ba6adf0dde015c44d14a884de`.
The final assistant readback state was not captured after the native approval
surface stopped refreshing, so it is not claimed as a complete conversational
turn. Final R12 native Chat and keyboard-control checks remain pending.
WordPress is a general-agent example, not a dedicated app feature or a
one-prompt autonomous completion claim. Historical incomplete attempts below
remain unchanged and are not converted into passing outcomes.

## Implemented behavior

- An empty model library opens normal download/import onboarding. Engine
  preparation, missing weights, catalog discovery failures, and genuine runtime
  errors have distinct messages and recovery controls.
- A retained usable model waits in the workspace while the engine initializes.
  Preparation blocks inference without automatically reopening model setup.
- Desktop status includes engine state/error codes, model-library errors, known
  model verification failures, and profile/data/model-cache identity. The regular
  profile retains the legacy data location. Isolated profiles show an explicit
  banner and their storage locations.
- Status responses use a generation guard. An older startup or setup response,
  including an older failure, cannot replace newer readiness.
- **Choose model** preserves task drafts and attachments. A failed send refreshes
  model status and opens setup when recovery is needed. Attachments are restored
  only when the saved transcript confirms the host did not record the request.
  A task that already ran does not stage its attachments again.
- A corrupt curated model shows **Needs repair** and **Download again**; a
  blocked model is not labeled **Selected**. Imported models use **Import GGUF**
  for recovery. Successful recovery does not automatically resend a task.
- **Research** and internet permissions are managed in **Plugins**. The duplicate
  composer chip is removed. **Find files & text** describes local workspace
  search explicitly and retains the existing saved preference.
- **Working** is a native disclosure showing actual model-supplied thoughts and
  tool inputs/results. It remains expanded across streaming, approval, and tool
  updates. Its current status prioritizes approval and running tools over an
  older preparation stage. Reading expanded activity or scrolling up pauses
  automatic scrolling. Expansion belongs to the conversation, and a fallback
  row uses its eventual assistant-message index, preserving an open disclosure
  when the first chunk moves it into the message. Bounded tool history is saved
  with the assistant exchange and remains inspectable after another turn or
  reopening the task. Calls retain their original names/inputs when later status
  updates omit them. Incomplete calls become interrupted when a turn stops.
  Display records never drive tool execution or replay. The display stores up
  to 256 calls and 16 KiB each for input/output, with explicit truncation notices.
  Only visible disclosures
  pause scrolling; hidden no-thinking rows do not affect later replies.
- Cancelled approval events remove only the matching request in the current chat,
  preserving other queued approvals and never sending an approval response.
- **Stop** also cancels preparation while the selected model is being verified,
  before a new request or tools start. Session creation and existing-chat sends
  share this cancellable preflight; stopping it does not record or replay a turn.
- Completed app-owned read-only exchanges can be compacted locally within a turn,
  with exact read IDs, arguments, and bounded source locations retained. Current
  instructions/request/tool schemas, all command/edit exchanges, pending or
  ambiguous exchanges, and the latest tool group remain exact. Summarization is
  bounded and never executes tools or replays a turn. Its summary allowance
  uses native-counted remaining capacity after the complete protected request,
  rather than a fixed context percentage. Oversized protected context still
  fails with an actionable smaller-request path.
- Commands retain a reviewed 60-second default execution limit, with explicit
  `timeout_ms` from 100 to 600000 ms for longer work. The native command bridge
  and Goose reviewed-action extension allow 1500 seconds for the request; other
  native action requests allow 900 seconds. These transport budgets preserve the
  ten-minute pending-approval cap and do not extend the approved command limit.
  Cancellation, disconnect, timeout, or unconfirmed action results stop the turn
  without automatically repeating completed or partially executed actions.
- A missing saved command log returns actionable **COMMAND_LOG_NOT_FOUND**
  guidance instead of a raw filesystem error: do not retry that UUID; use only
  the log ID returned by `run_command`, and use `read_file` to verify edited files.
  Successful file mutations also name `read_file` as the verification path and
  explain that edits do not create command logs.
- Command results provide `log_id`, the complete `durable_id`, `output_complete`,
  and `next_offset`. A returned `log-xxxxxxxx` handle resolves only an exact
  unique saved log within the current chat; prefix collisions use the durable
  UUID. Unknown, ambiguous, malformed, traversal, and cross-chat references
  are rejected. Complete output needs no further log read. Paging reads saved
  bytes and never executes a command.
- macOS **Add folder** and **Create folder** use asynchronous standalone native
  application-modal panels with Documents as the initial directory. Both clear
  native file-type restrictions and retain directory-only selection. The main
  process still validates and grants the selected path. Their complete visible
  folder-to-task acceptance remains a separate check.
- Bundled Goose ACP initializes the local tool extensions with the fixed MCP
  `2025-11-25` protocol. A reproducible vendor/build guard enforces this generic
  compatibility patch, avoiding a modern-discovery timeout followed by an
  incompatible legacy initialization on cold Python startup. Offline metadata
  and disabled update settings remain enforced.
- **File → Save screenshot…** captures the actual app viewport as PNG and asks
  for a destination in a native Save dialog. Cancellation does not write a file.
  This is a visible app control, not a simulated conversation or hidden test hook.
- Native spellcheck and text-field correction/capitalization are disabled as an
  input-latency mitigation. Observed spell-server timeouts do not establish the
  cause of earlier stale desktop automation or captures.
- Agent welcome examples are general project tasks. Existing folder creation,
  cancellation, approvals, and undo remain available.

## Automated evidence

The final alpha.3 source passed strict TypeScript and **210/210 app/runtime tests**,
with no failures, skips, or cancellations, public networking denied, and loopback
allowed. The run took **38060.4675 ms**. This includes startup, cancellable model preflight,
approval-disconnect, first-chunk Working disclosure, command time limits, and
within-turn read-only compaction, missing-command-log guidance, and six new
durable-tool-history checks, three exact-log/paging regressions, two remaining-
capacity regressions, plus a real nine-second delayed-tool-start regression
using the bundled Goose ACP. The local
run log is `.cache/general-agent-validation/check-r12-offline-sequential.log`. The final
rebuilt macOS Apple Silicon package and offline native smoke passed. These
results do not establish a completed visible GUI task or model quality benchmark.

The final ZIP is **216,988,256 bytes**, SHA-256
`8dd30c4b8a201b7253d671240fb434cfcf1b8cce4ac1eaf150021ebdd1a56ff0`.
The packaged ASAR SHA-256 is
`cd7c1a487cb3d9b03236e1b364731e47c54a4e7def4e12a4b96913dfb67d60df`.
The [delivery artifact record](general-agent-package.json) identifies the local
archive, build time, source-test count, and packaged smoke outcome. The package
is unsigned, unnotarized, and not pushed.
The local archive is in `release/general-agent-delivery/`; its packaged
smoke log is `.cache/general-agent-validation/smoke-r12-offline.log`. The smoke
also initialized both tool extensions through the actual packaged Goose ACP
against a metadata-only loopback endpoint. It sent no model prompt and could
not call an inference endpoint. The packaged Goose SHA-256 is
`3f4cbe2770ebf24a11248f82fa825f0ed969ab9d74912f8f6104dc067d840055`,
and its manifest records MCP `2025-11-25`. R8 and R9 shared the app ASAR; their
archive and Goose checksums distinguish the backend repair.

The preceding alpha.3 app reopened in its regular profile. The preservation check on **2026-10-10** at
**17:07:24 UTC** retained **five saved chats**, selected Qwen3.5 4B, one undo
group, and the existing **2,740,937,888-byte** model. The chat store remained
unchanged, SHA-256
`ff627327fd1e299492d55450b39f0472d6bd6313eb680e643dfa4055683c241d`.
The separate preview's interrupted **156,942,952-byte** GGUF download remained
unchanged. The [sanitized component evidence](general-agent-components.json)
includes this metadata/hash summary without raw chats, undo contents, drafts,
or user paths. This establishes retained data, not a completed interactive task.

A separate read-only check on **2026-10-11** again found the regular chat-store
hash unchanged and the preview partial still **156,942,952 bytes**. This check
did not reopen the final folder-fixed package in the regular profile and does
not establish a new upgrade or interactive-task result. Its metadata is recorded
separately from the earlier reopening evidence.

The current checked-in suite includes **10 renderer-flow helper tests** for status
ordering, obsolete failures, unmount cleanup, onboarding, readiness, scroll
behavior, retained-model startup, tool/approval status, and disclosure identity.
All 10 focused tests
passed after the latest renderer changes; they are part of the main suite,
not a separate count to add to it.

An additional hidden Electron harness exercised the actual built React
renderer with synthetic IPC and passed **14/14 scenario groups**. These groups
are separate from the main test suite and use no model inference. All 14 were
rerun successfully after the Stop fix. The later command-log and folder-picker changes
through R7 did not change those tested renderer assets, as an exact hash
comparison established. R8 changed the renderer to retain tool history. Those
14 groups have not been rerun for the current renderer; R10 also changed
text-field spelling attributes. Six new bounded-history/migration tests
passed in the current 210-test suite. The original renderer evidence and the
historical R7 asset comparison keep their preceding package provenance.

| Renderer scenario | Result |
| --- | --- |
| Empty library: normal onboarding, download completion, enabled send, preserved draft and attachments | Passed |
| Visible isolated-profile identity, local-search explanation, Research only in Plugins | Passed |
| Retained usable weights wait during engine initialization and become ready without reopening setup | Passed |
| Delayed startup snapshot cannot reopen setup or replace ready state and inputs | Passed |
| Initial status-read failure opens setup; retry restores readiness | Passed |
| Expanded Working retains real fixture thoughts, named tools, approval state, and completion | Passed |
| Permission cancellation removes only the matching current-chat request, preserving the queue and sending no response | Passed |
| Streaming/final synchronization preserve expanded activity and chosen reading position | Passed |
| Fallback Working moves into the first assistant chunk while retaining open thoughts and tool activity | Passed |
| Hidden no-thinking disclosure does not suspend scrolling for the next reply | Passed |
| Rejected preflight restores inputs; accepted-task failure does not restage attachments | Passed |
| Model disappears in an existing chat: setup opens, no request is recorded, recovery does not replay it | Passed |
| Corrupt curated model offers Download again, avoids Selected, and does not replay work | Passed |
| Model-library discovery error is visible and model actions remain blocked | Passed |

The local renderer report is `.cache/general-ui-review/results.json`; the
paired fixture files are in that ignored directory. Synthetic thought and tool
events validate rendering behavior, not native model output. Hidden Electron
requires normal macOS GUI initialization and cannot establish visible Enter or
Space activation.

## Real packaged-component checks

The actual shipped inference engine, Goose agent, sidecar, and reviewed action
tools ran with the existing verified Qwen3.5 4B artifact through an isolated
approval harness. This used real model output and tool execution, with explicit
per-action approval decisions rather than automatic approvals. It did not control the
visible renderer. A completed run used the preceding alpha.3 package, ASAR
`39c4d025a7cf3bc8adcbb040bd33910a7a2ba0365a7538c375bdeb05cfaa0011`, with
public networking denied and loopback allowed, before the latest command-log
fix. Two earlier runs are retained
separately with their original pre-disconnect-fix provenance; the final artifact
does not retroactively identify those older packages.

| Task | Independently recorded result |
| --- | --- |
| Preceding-package ordinary local Chat: calculate 17 + 25 | Passed with public networking denied: final answer exactly `42`, no tool events; exact original ASAR provenance retained |
| Preceding-package general Agent file task | Passed with public networking denied: two approved mutations created and edited `validation-note.txt`; independent final file was exactly `Local agent works locally.\n`, 27 bytes, SHA-256 `0451c6b8f88f5a0112a7d5f7dd5feb4ed42f86212e9787864ecbebf0a9785370`; all eight tool events retained with original ASAR provenance |
| Earlier package's file task and tool-error recovery | Two approved mutations produced the same exact text in `notes.txt`. One `read_command_output` attempt supplied an invalid UUID and failed validation; the agent recovered with real file reading, edited, and verified the file. All 10 tool events retained with that run's original provenance. |
| Earlier separate offline Chat: calculate 17 + 25 | Passed: final answer exactly `42`, no tool events, public networking denied with loopback allowed; original package provenance retained |

The preceding-package run's short calibration measured **37.902 tokens/sec**. The
earlier chat/file run measured **30.393 tokens/sec**, and the earlier separate
offline chat measured **32.9375 tokens/sec**. All three used
Metal, an **8192-token context**, **2048 reserved output tokens**, **batch 256**,
and **microbatch 64** on the Apple M5 / 24 GiB machine. Each is a single
calibration sample; neither is a representative latency distribution, task
benchmark, or peak-memory measurement.

The model SHA-256 was
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
Weights were reused locally, with no new model download. Owned harness
processes stopped. See [sanitized component evidence](general-agent-components.json)
for separate run records, task requests, approvals, tool outputs, independent
assertions, exact timings, and calibration values. Absolute local paths and raw
token-sized thought events were omitted from the public evidence.

That recorded offline component run also attempted a Docker-image inspection. Its
first exact command failed because the offline test wrapper denied access to
the Docker Unix socket. A second proposed command was cancelled while pending;
the turn stopped without automatic repetition. This third task did not pass,
so the run's aggregate result remains false despite its independently passing
chat and file tasks. The socket restriction is a harness limitation, not evidence
of a model-provider dependency or a verified site. Normal-socket attempts are
recorded below; ongoing smaller repairs are not claimed as completed evidence.

The first WordPress component turn was interrupted. Only Docker/Compose version
inspection was approved and run; no WordPress project files were approved or
produced. An approval-bridge fetch failed while native capture was blocked, leaving a
pending approval for more than five minutes. The pending action was not
approved and the turn was stopped. The final source includes the
disconnected/expired approval boundary fix; this recorded attempt was not
rerun to establish a running site.

A later staged component attempt approved five scaffold actions, creating
`compose.yaml` and `README.md`, checking Compose configuration, and editing it.
The check preceded a later edit, and the scaffold stage ended with an
output/context-limit error. An approved `docker compose up -d` then timed out
during image download at its 60-second default limit and ended with another
context-limit error. Verification was cancelled at a pending Docker-version
approval. The turn stopped and owned model processes shut down; no installed
site was independently verified. Completed harness stages mean their transport
finished, not that the requested task passed. See the
[sanitized task-attempt record](general-agent-task-attempts.json).

Those observations motivated the general explicit command limit and completed
read-only compaction changes. Their automated checks passed in the final source
suite. A continuation's approved `docker compose pull` with `timeout_ms: 600000`
exited 0 and reported all three images downloaded. Its following healthcheck edit
was speculative and was denied before execution. A further prerequisite turn
proposed an incorrect `mysql/mariadb` image command; it too was denied before
execution. Each denial stopped the turn without automatic retry or action replay.
Both runs shut down their owned processes. These are two more incomplete task
attempts in the sanitized record, not proof of an installed site. No
WordPress-specific prompt, template, tool, or implementation branch was added.

A fifth attempt used that preceding package and normal Docker socket access with
previously downloaded images. Approved official-image inspections found
`healthcheck.sh` and `mariadb-admin` in MariaDB. Its helper did not support
`--help`, so that command exited 1; WP-CLI was found at `/usr/local/bin/wp` and
reported version **2.12.0** with exit 0. Despite those observed names, the next
configuration replacement invented `mysqlhealthcheck.sh`. That proposed write
was denied, made no change, and stopped the task without retry or replay. Owned
processes shut down. This attempt remains incomplete.

A sixth, smaller repair attempt completed one approved exact healthcheck edit
using the observed helper. That change is preserved. The model then made six
identical reads of a nonexistent command-log UUID instead of reading the changed
file. The turn was stopped without a final response, and owned model processes
shut down. This is partial edited work, not a passing task or an unchanged
workspace. It motivated the general missing-command-log guidance in the current
build; the later component snapshot below records that preceding rebuilt artifact separately.

These runs show a limitation of the tested 4B model: fresh tool results did not
prevent unsupported configuration proposals. Smaller guided steps, per-action
review, and independent validation remain necessary. Passing simple chat and
file tasks does not establish reliable autonomous completion of a larger setup.

A later component run used the preceding missing-log-fix ASAR `0fa0…578af`,
before the folder-picker correction. Its ordinary chat
assertion passed with final answer exactly `42`, no tool events, and 4,210 bytes
of model-supplied thinking. Its short calibration measured **38.023 tokens/sec**
with the same Metal / 8K / batch 256 / microbatch 64 profile. Public-network
denial was not established for this run. The next file task approved one create,
recovered from a missing command-log result by reading the file, and reached an
unresolved edit approval. The report has no final timestamp or cleanup result.
It is retained as an explicitly unfinalized snapshot, with no overall pass/fail,
file-task completion, shutdown, or WordPress result inferred. Fresh acceptance
work is being performed in the visible app.

## Visible GUI evidence and remaining gaps

The packaged app's initial native empty-profile screen was captured. It shows
the real onboarding flow, with no downloaded model and no missing-model runtime
failure. This initial capture is partial evidence, not a completed task run.

![Initial native model onboarding](screenshots/free-local-agent-first-model.png)

A fresh native capture of the preceding reopened alpha.3 app shows the task workspace,
separate-profile banner, selected Qwen3.5 4B, and local engine ready. This window
still requests tool calibration and shows no selected folder; it is interface
evidence, not an executing task or expanded Working. Its renderer assets
matched through R7; R8 subsequently changed them for durable tool history.
This earlier capture does not establish the latest native task flow.

![Final native alpha.3 workspace](screenshots/free-local-agent-workspace-alpha3.png)

Further native automation has been intermittent: ScreenCaptureKit reported
`SCStreamErrorDomain -3811`, and app inspection sometimes reported changed-app
or no-window state. A separate validation app identity was tried. These errors
describe the capture/automation limitation; they do not establish an app graphics
root cause. No screenshot of a simulated conversation is presented as a real
model task.

Separately, local model import through the native file picker succeeded. The
Create folder dialog accepted a folder name and opened the native parent picker,
but its confirmation remained disabled, so native folder creation is not a
completed check at that stage. Mouse and keyboard activation of real-task
Working were also unproven at that stage.

A fresh native parent-picker capture also showed a selected folder with its
confirmation disabled. Its controls were readable, but programmatic text,
paste, Tab, and window activation did not take effect; coordinate interaction
reported no available window. Those earlier source and compiled-app inspections found an existing-directory
picker API, but did not explain its disabled confirmation. The current build
explicitly clears macOS file-type restrictions in both directory pickers while
keeping folder-only selection. The historical capture still does not pass native
folder creation; the corrected build requires its own visible task check.

The user created `wordpress-working-test`. On **2026-10-11**, the preceding
missing-log-fix build (ASAR `0fa0…578af`) selected that existing folder through
native **Add folder**. The selected workspace was read through accessibility,
and the app displayed a short calibration result of **28.7 tokens/sec**. This
was actual native partial evidence, with no completed Agent turn or fresh task
screenshot.

The preceding file-filter-reset build (ASAR `939470…a142`) then opened with that workspace
and Qwen selection retained, but requested recalibration. A later GGUF picker
attempt selected the existing verified local file; **Open** remained disabled,
and the picker was cancelled. No import completed and no change resulted from
that cancelled attempt. HTML accessibility clicks remained intermittent,
reporting invalid element ids or no available window, and screenshots were
stale. Real-task Working expansion and visible mouse, Enter, and Space activation
were unverified in that preceding build.

A controlled native-dialog fixture successfully returned a selected existing
directory from a standalone panel. In the preceding packaged app, the attached
Create folder parent sheet still showed disabled confirmation and was cancelled.
The R7 delivery (ASAR `2536…d16c`, source `85e5e75`) used the standalone
application-modal form for workspace directory selection. Fixture success does
not establish completed folder creation or a task in this rebuilt app. A later
check of the actual rebuilt app completed **Create folder**: the native parent
picker returned, `wordpress-app-acceptance` was created, and the app selected it
and displayed its creation confirmation. This is R7 native folder
evidence; completed task execution remains a separate check.

![R7 packaged app after native workspace creation](screenshots/free-local-agent-created-workspace-r7.png)

In the R7 app, a new prerequisite-inspection turn used actual Qwen3.5 4B
inference. **Working** expanded with a mouse click, collapsed with Space, and
expanded with Enter. Actual model-supplied thinking streamed in the disclosure;
`list_files` inputs and results were inspected. An approved `docker --version`
command then completed once with Docker **29.5.3**. Expansion persisted across
model and tool updates. The screenshot below is the real packaged app, not
synthetic renderer IPC. This establishes the requested disclosure interaction
and initial approved execution on R7, before the later site creation/installation. The subsequent R8 rebuild retains tool details when a new turn starts
or a saved task is reopened; its own native acceptance remains a separate check.

![Expanded Working during actual native model/tool execution](screenshots/free-local-agent-working-thinking-r7.png)

The preceding R8 app recalibrated the retained Qwen model with Slow mode after a
hardware refresh and displayed **7.7 tokens/sec**, Metal, and an **8192-token**
context. Available memory was approximately **4.1 GB**. A fresh repair/install
request was submitted through the native composer in `wordpress-app-acceptance`,
and Working was expanded with the mouse before model output. These are partial
R8 observations, without installation, completed execution, or a final task
screenshot for that revision. Two native R8 attempts stopped before actions when the bundled
`local_files_and_research` MCP did not finish initialization; the reviewed-action
extension itself started. Direct MCP startup succeeded in a separate diagnostic.
The measured cold Python startup was **8.35 seconds**, exposing Goose's roughly
**8.28-second** discovery deadline and an incompatible legacy initialization
retry after the modern protocol had already been accepted. The R9 vendor/build patch fixes
Goose ACP initialization to the supported bundled protocol. Its real delayed
startup regression and packaged ACP startup smoke passed; the new app’s native
acceptance remains separate. Neither failed R8 turn executed an action or
established a WordPress result.

The preceding repaired R9 backend then completed a guided correction through the actual
app. One reviewed `compose.yaml` write executed once, followed by `read_file`
verification. The saved assistant exchange retained **2,180 bytes** of
model-supplied thinking and **five named tool records**, with inputs, results,
and statuses: two failed invented command-log reads, the Compose read, the
approved write, and its verification read. Native accessibility inspection
showed five activities at completion. No action was pending when the completed
test app was restarted; no automatic replay was requested. This proves native
approved editing and saved Working history on the recorded R9 ASAR and Goose
checksums. After reopening the actual app and saved repair task, the Thinking
disclosure visibly expanded and displayed all five named tools, confirming
durable history in the native interface. A new short calibration displayed
**12.1 tokens/sec** with Metal, 8192-token context, Slow mode enabled, and
approximately 4.1 GB available memory. These results do not prove started
services or installed WordPress.

A subsequent native request proposed `docker compose --profile tools config
--quiet`; it was denied before execution. The observer found zero new action
records for that attempt. It did not start services, install WordPress, or
automatically replay the denied command. Any retry is a separate explicit
request through the normal approval boundary.

An independent preservation check also compared **six existing undo records**
and found them unchanged, together with the regular chat hash, five saved chats,
selected Qwen model, **2,740,937,888-byte** GGUF, and preview’s
**156,942,952-byte** interrupted download. Model size and previously verified
checksum provenance were retained; this comparison did not newly hash the
complete model. The latest read-only comparison at **2026-10-11 11:20:59 UTC**
confirmed the same unchanged chats, six undo records, model size, and preview
partial size. This also was a persisted-file comparison, not a fresh full-model
hash or interactive reopening of the regular profile.

In the preceding R10 app, **File → Save screenshot…** opened the real native
Save dialog with confirmation enabled and exported an authentic PNG of its
new-task viewport. A subsequent actual R10 turn read the task instructions and
`compose.yaml`, then executed one normally approved configuration check. The
check failed because the generated `healthcheck.test` format required CMD,
CMD-SHELL, or NONE. Working showed actual streamed model thinking, named file
reads, the command’s failure status, and expandable inputs/results. Mouse
expansion persisted through updates, and the tool details toggle was visibly
checked. The screenshot below matches fresh native accessibility and pixels;
it is the real model/tool task before the later R11 repair and installation.
R7 captures above retain their exact older package provenance.

![R10 actual expanded thinking and tools during configuration validation](screenshots/free-local-agent-working-thinking-r10.png)

The completed R10 attempt ultimately made **two normally approved configuration
checks**, both failing on that same healthcheck format. Its next invalid
healthcheck edit was intentionally denied; the Compose hash remained unchanged
and no edit action record was created. The assistant exchange saved seven actual
tool records with model thinking. The denial stopped the turn without service
startup, installation, or replay. A further repair must be an explicit new
request with normal approval.

A subsequent guided R10 correction request saved six real tools and model
thinking, but its two exact-text edit attempts failed matching and changed no
file. Across the frozen R10 evidence, **three approved configuration commands**
ran and failed; no edit, service start, or WordPress installation succeeded.
The earlier R9 correction remains the recorded successful edit. The rebuilt R11
package improves generic log identity and paging guidance. Its later native
repair, startup, installation, and independent acceptance are recorded below. The acceptance uses guided separate tasks and
normal approvals, not a claim of one-prompt autonomous setup.

The next bounded task in the preceding R11 app completed a correct healthcheck
repair. One normally approved edit applied once and produced a valid CMD array;
independent file/action inspection confirmed it. The finalized exchange saved
**684 thinking bytes** and **two completed tools**: file read and exact edit.
No service had started and no WordPress installation was established at this
stage. The task remains a guided multi-request acceptance test.

The next preceding R11 app task validated Compose and started the cached services
through normal command approvals. The `--pull never` start executed **once**
with an approved **300000 ms** limit. Independent read-only Docker inspection
found the database **healthy** and WordPress **running** on
`127.0.0.1:8096`. The finalized exchange saved **four completed tools**
(`list_files`, `read_file`, configuration check, and start) and **1,011 thinking
bytes**. This stage establishes native approved startup. The later app
installation and independent 12-check validation establish core, homepage, and
login acceptance. The observer did not start or install the project.

The approved R11 `core is-installed` query subsequently executed once and
returned exit **1**, confirming that WordPress was not installed at that point.
The app subsequently requested approval for one install and a distinct
post-install query; both completed successfully. The query returned exit **0**
and did not reinstall or replay an action. The install exchange finalized
normally at **10:58:35 UTC**, saving **five real tools** and **1,433 thinking
bytes**. R12 packaged smoke passed, and its isolated native copy matches the
new artifact checksum; the final R12 Chat/file/control checks remain pending.

A separate packaged-component WordPress run was attempted in another isolated
workspace at `http://127.0.0.1:8097`. No passing result was accepted from that
run. It does not establish the requested native app workflow, and its guided
stages are not claimed as one-prompt autonomous completion.

| Acceptance check | Current status |
| --- | --- |
| Current R12 native Chat and final controls | Pending; the preceding native WordPress result retains R11 provenance |
| Current R12 native handoff and saved Working history | Passed: seven completed tools, 2,984 thinking bytes, normal approvals, uploads permissions and RUNNING.md independently verified; mouse expansion persisted, and saved Thinking/tools reopened visibly |
| Current R12 native Create folder | Passed: native parent-picker confirmation was enabled, one click created empty general-file-test and selected it; persisted profile/filesystem independently match, without observer creation |
| Current R12 native general-file task | Approved creation, denied incorrect edit, and one exact approved correction applied; independent final file readback is `Local agents can build tools.` (SHA-256 `f6bdd21ecd9728d3da5d9d1a070dba34d204524ba6adf0dde015c44d14a884de`). The final assistant readback state was not captured after the native approval surface stopped refreshing. |
| Recorded packaged-components ordinary local chat | Passed on preceding ASAR `39c4…0011` with public networking denied; preceding missing-log-fix ASAR `0fa0…578af` also returned exactly `42`, zero tool events in an unfinalized run, without network-denial proof; visible GUI not established |
| Current native guided Compose repair | Passed on R11: one approved/applied healthcheck edit, two completed tools and 684 thinking bytes |
| Native approved configuration/start stage | Passed on R11: validated Compose, exactly one approved cached-image start, DB healthy and WordPress running on loopback8096; later native installation and 12-check acceptance also passed |
| Recorded native guided file correction and saved Working history | Passed on R9: one approved Compose write, verification read, 2,180 thinking bytes and five named tool records retained with inputs/results/statuses; this correction did not establish services/installation |
| Recorded packaged-components general file-editing task with approvals and independent readback | Passed on preceding ASAR `39c4…0011` with public networking denied: two approved mutations, exact 27-byte result and hash; preceding missing-log-fix attempt approved one create and reached an unresolved edit approval; visible GUI not established |
| Earlier separate real local chat with public networking denied | Passed: exactly `42`, zero tool events; original recorded package provenance retained |
| Recorded regular-profile reopen and preview preservation | Earlier reopening passed on ASAR `39c4…0011`; read-only checks on 2026-10-11 again found chat hash and preview partial size unchanged; final-package regular-profile reopening not established |
| Native Create folder → Agent task → visible expandable Working during execution | Passed across recorded revisions: R7 Create folder selected the new workspace and actual task showed streamed thinking/tools with expansion retained; R9 history restored visibly; R11 guided setup reached the independently verified installed site. Final R12 control recheck remains pending |
| Visible mouse, Enter, and Space disclosure activation | Passed on R7 ASAR `2536…d16c` during actual Qwen thinking and tool updates; final R12 recheck pending |
| New WordPress project installed and running with healthy DB, homepage HTTP 200, and admin login | Passed on R11 through guided native app tasks: 12 independent checks, installed WP7.1.3, expected title, healthy DB, loopback homepage200 and actual loginform200; later R12 uploads-permission repair/handoff independently passed; browser media upload untested |
| Real-model task screenshots, task timing, and resolved container-image digests | Genuine R7/R10 app captures and R11 installed homepage/login captures; three official ARM64 digests verified and recorded; no end-to-end latency distribution or peak-memory claim |
| Final alpha.3 source checks including missing-command-log recovery and folder-picker correction | Passed: strict TypeScript and 210/210 tests, zero failures, skips, or cancellations, public networking denied |
| Final alpha.3 rebuilt package smoke, archive size, and SHA-256 delivery record | Passed: offline native smoke; 216,988,256-byte macOS arm64 ZIP in `release/general-agent-delivery/`; [exact artifact hashes](general-agent-package.json) |
| Windows/Linux native packages and real-model checks | Pending on their own platforms |

The WordPress check must use the same general Agent, normal approvals, and its
generated project files. It must independently verify an installed site and
retain stop/restart instructions. A packaged-components harness can verify
native inference, Goose, and approved tool execution, but does not replace the
pending final R12 native Chat/file/control checks.

No speed distribution, peak memory, long-context benchmark, or broad model
quality claim is made in this report. The calibration samples above are
recorded separately from historical Qwen measurements. Previous WordPress task
failures remain in their original reports.

## Installed native task result

One app-approved R11 core installation executed successfully, followed by
the independent 12-check validator. Installed versions were WordPress
**7.1.3**, PHP **8.3.35**, MariaDB **11.4.13**, and WP-CLI **2.12.0**. The
validator did not start services, pull images, install, or edit the project.
The five transient cached CLI containers performed read-only queries only.
The app then requested a distinct normally approved `core is-installed`
postcheck, which exited **0**. The install turn finalized normally at
**10:58:35 UTC** with **five saved tools** and **1,433 thinking bytes**: project
list/read, the expected-failure precheck, one successful install, and the
successful postcheck. Exactly one installation executed; the postcheck was
a read-only action, not an automatic replay.

![Real installed homepage from native app acceptance](screenshots/free-local-agent-wordpress-home.png)

![Real administration login form after installation](screenshots/free-local-agent-wordpress-login.png)

The initial install reported that `wp-content/uploads/2026/10` could not be
created due to permissions. The later R12 app task created that directory
as `www-data` and wrote `RUNNING.md` through normal approvals. It finalized at **11:17:20 UTC**
with **seven completed tools** and **2,984 thinking bytes**. Independent
read-only checks confirmed the uploads and dated uploads directories writable
as `www-data`; they made no setup writes, pulls, starts, installs, or replay.
Browser media upload was not tested.

The generated **620-byte** handoff contains the correct local URL, safe stop
and cached-image restart commands, and all three exact official tag/digest
pairs, with no password. Its SHA-256 is
`aef8048b70984ce31136c812d4fd2277a45e72a882b47ff9bae51dd609b32547`.
See the [public native acceptance JSON](wordpress-native-acceptance.json) for
exact results, separate R11/R12 source/package hashes, and verifier scope.

The final R12 native **Create folder** check also passed. The app opened its
native parent picker, enabled **Create folder here**, and created and selected the
new empty `general-file-test` workspace with one confirmation. Independent
filesystem and profile inspection at **11:27:02 UTC** confirmed the directory
and matching saved selection; the observer did not create it. The small
non-WordPress task and remaining keyboard/Chat checks are recorded separately.

The first R12 general-file task created `acceptance-note.txt` once through
normal approval. The model then proposed an edit containing unwanted extra text;
it was intentionally denied. Independent action/file inspection confirmed the
original bytes unchanged, one creation, zero applied edits, and no commands.
The turn finalized with four tool records and 980 thinking bytes. A fresh
explicit correction is required; the full general file-editing acceptance is
not marked passed at this stage.

## Retained test project

The isolated project remains in `.cache/general-agent-validation/wordpress-app-acceptance/`
under this checkout. Its site is <http://127.0.0.1:8096/> and its administration
login is <http://127.0.0.1:8096/wp-login.php>. Run these from that project folder,
or ask the app to execute them with normal command approval:

```sh
docker compose stop db wordpress
docker compose up -d --pull never --wait --wait-timeout 120 db wordpress
```

The first command stops the two services; the second restarts the cached images.
Both preserve the database and WordPress volumes. The app-created `RUNNING.md`
in that project also contains verified stop/restart commands and image digests.

## Evidence references

- [Build verification](build-verification.md) distinguishes current automated
  checks from earlier version evidence.
- [Compatibility report](compatibility-report.md) retains hardware measurements
  and native-platform limitations.
- [Earlier Working/folder validation](working-folders-validation.md) records the
  alpha.2 thought separation run and its exact artifact checksum.
- [Earlier complex-task record](wordpress-agent-smoke.json) records a failed
  full-project check; its approved file creation is not a running-site result.
- [Current task attempts](general-agent-task-attempts.json) retain sanitized
  approval/tool evidence for six incomplete real-model component attempts.
- [Final delivery artifact](general-agent-package.json) records the rebuilt
  macOS arm64 archive and packaged smoke result separately from older task runs.

The macOS alpha remains unsigned and unnotarized. This historical update predates
the tagged GitHub Release workflow; current package downloads are listed on the
[GitHub Releases](https://github.com/mahdizareeii/AiAgent/releases) page.
