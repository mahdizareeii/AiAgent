# Alpha.4 validation record

Updated: **2026-10-13**. Version: **0.4.0-alpha.4**. **Current delivery: R9.**
R9 passed **328/328 automated checks**, TypeScript and actual packaged smoke
with macOS-enforced public-network denial. Its narrow attachment-path instruction
change passed a fresh native cross-workspace attachment read: one completed tool,
exact text/digest and a nonempty final answer with no mutations. Fresh R9 Chat
returned only `42` without tools; normal quit/relaunch restored that answer,
Chat mode and 100% text size. Final regular-profile restoration, normal-save v4
migration and regular speed/tool calibration passed; the original five chats,
six undo records and verified Qwen weights were retained.
The preceding
R8 passed **327/327 automated checks**, TypeScript and actual packaged smoke
with macOS-enforced public-network denial. Native empty setup, attachment/model
selection, import without restarting, Chat `42` and reopening, screenshot focus
recovery, and folder creation passed. Working mouse/Enter/Space checks passed
during a read task that used an incorrect relative path and was cancelled after
failed calls. That readback did not pass. A separate request in the correct
workspace completed one read and an exact text/digest answer without mutations.
The R7 package passed **315 offline
automated tests**, TypeScript, packaged smoke, **94 Python source tests** and
**8 frozen protocol tests**. R7 CLI repair, exact-file work, retained-file readback and
ordinary Chat passed their recorded checks; Chat/preferences survived reopening.
Empty-profile onboarding and regular-profile startup passed visibly in a
2026-10-13 follow-up. The R7 task/model runs below were recorded on 2026-10-12. Native
Qwen calibration measured 28.9 tokens/sec on Metal with 8K context, and Working
mouse/Enter/Space expansion was visibly checked during a running CLI repair.
That app-applied repair passed **4/4 independent input checks**, with its final
answer/readback and completed terminal state visibly confirmed.
The verified Gemma download reached an explicit final R7 experimental load,
which the app stopped at its sampled resident-memory budget before Chat/tool
probes. Independent resource samples confirmed the owned CPU-only process and
its exit; returning to Automatic restored Qwen Metal inference. Delivery
remains local. This report preserves payload identities, failures and genuine
captures separately; it does not establish general model competence or complete
project autonomy.

The R7 implementation and screenshots were committed **locally** as `ea8cd31`,
with documentation corrections in `678e0b8`. R9's dialog/path-guidance source and
regression tests were committed locally as **`b7a72d2`**; no push was performed.
The new captures/documentation are separate local evidence work. Recorded R8/R7
native task/model results remain bound to their own retained payloads.

## Current R9 package identity

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `release/alpha4-delivery/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip` | 217,115,849 bytes | `5bc0634d9d33dbf1a47cb8e7a9d6c9aebed6b71e19ab23b871faf063879a160c` |
| `release/alpha4-delivery/mac-arm64/Free Local Agent.app/Contents/Resources/app.asar` | 32,015,937 bytes | `792ccb209899aa8c5334d9b6e1db6a77701074fa7802a4462f5142c8190c8bb8` |

Both sizes and full-file hashes were independently read from the R9 delivery and
match `package-identity.json`. R9 changes the backend's general instructions:
relative paths apply to **project mutations**, while granted attachments are
read using their supplied **absolute paths** when file reading is enabled.
This removes the contradictory blanket relative-file-path instruction without
changing the file grants, approval or action-replay guards. The fresh native
attachment-read passed; the earlier R8 failure remains recorded below.

R9 retains R8's centralized native dialogs: macOS uses standalone
panels for folder/file selection, model import and screenshot export, while other
platforms retain parented panels. The original live app window regains focus
after selection, cancellation or an error; a disposed window cannot replace the
native result/error. Its current native checks are recorded below. The earlier
R7 Agent/file/CLI/Gemma results and screenshots retain their own payload identity.

## R9 native attachment read — passed with exact readback

The new R9 ASAR is running in the test profile retained from R8, with its verified
Qwen model. The selected workspace is `alpha4-r8-dialog-workspace`; the attached
note is outside that workspace. Its native picker selected the attachment using
an enabled **Open** control. Separately cancelling an empty attachment picker
returned focus to the app without adding an attachment. A fresh general prompt
asked for the attached file without supplying its exact path in the user's
request. Session `0b18cc0a-453f-4a67-8d87-5ed225ef1de6` made one `read_file` call
with the attachment's actual absolute path outside the selected workspace,
`start_line=1` and `max_lines=50`. The completed tool returned the complete
**29-byte** UTF-8 text **Local agents can build tools.**, `eof=true`, and SHA-256:

```text
f6bdd21ecd9728d3da5d9d1a070dba34d204524ba6adf0dde015c44d14a884de
```

At **08:08:30.615 UTC**, the saved outcome was **completed / end_turn**, with
**one Passed read check** and a **465-byte** nonempty final answer containing
that exact sentence/digest. There were no edits, commands or approvals. The
native tool input and real model thinking were expanded and inspected; the
thinking is retained locally (**1,307 UTF-8 bytes**). The collapsed final view
visibly showed the actual answer and digest. Independent read-only inspection
of the saved tool output/outcome matched those native observations. This is
separate from R8's successful explicit-path request in the file's own workspace;
it does not reclassify the failed R8 attachment attempt.

## R9 fresh Chat and normal reopening — passed

Session `1b8340f0-fc4c-46a8-ba72-98855b3fb10a` used Chat with the exact prompt
**What is 6 × 7? Reply with only the number.** It completed at **08:10:23.107 UTC**
with `completed` / `end_turn`, a two-byte answer **42**, no tools and no approvals.
The saved model identity is verified Qwen3.5 4B, Metal, 8K context, Automatic.
The native answer was visibly confirmed and genuinely captured. After a normal
Quit and relaunch of the same R9 app/profile, selecting the saved arithmetic Chat
visibly restored **42**, **Chat** mode and **100%** text size. No agent turn was
replayed. Saved state was also independently inspected read-only.

## R9 regular profile restoration and saved v4 migration — passed

The final R9 delivery app opened **without a user-data override**, using the
regular `~/Library/Application Support/Local Agent` profile. Native inspection
confirmed its **five original tasks**, `test` workspace, selected Qwen, **Local
model ready**, dark theme, **100%** text size and **Careful Agent** new-task default.

The normal Careful → Standard → Careful preference controls invoked the existing
main-process save and performed the actual persisted **version 3 → version 4**
migration. Independent before/after comparison found every original v3 field
retained except the version change, including **all five complete original
sessions**, messages, attachments and project paths. No session or message was
added. Existing tasks with no saved effort retain the effective **Standard**
fallback; no legacy turn was executed or replayed. All **six undo records**
retained their complete hashes and unchanged path set. The full Qwen artifact
remains **2,740,937,888 bytes**, SHA-256
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
The new persisted defaults are Automatic memory mode and Careful new-task effort.

**Measure speed & tool format** then passed visibly in the regular R9 app,
measuring **11.1 tokens/sec** on **Metal**, **8,192 context tokens**, **Automatic**.
After the separate offline component check, the regular app was reopened again
and its native speed/tool probe passed at **11.0 tokens/sec**, with the same
Metal/8K/Automatic profile. It was left open on the Careful task screen at 100%
text size. The screenshot below records the first 11.1-token/sec preparation.
Returning to the task screen removed the calibration banner; the speed notice
was dismissed. Its genuine final screenshot shows the ready regular workspace,
and saving it returned focus to the app. This short sample is separate from R8's
15.2 and R7's 28.9 measurements; it is not a sustained-performance or task-quality
guarantee.

Migration provenance is retained in
`.cache/general-agent-validation/alpha4r9-regular-migration-audit.json`, whose
independent observer performed no save or app interaction. Text scale is stored
in renderer localStorage; the normal main-process task-effort preference change,
rather than a text-scale change, triggered the persisted migration.

## R8 native setup, import, Chat and dialog checks

The final R8 ASAR `77c9b33b…340e` opened in a genuinely empty
`profile-empty-r8-visible` profile. The bundled engine initialized without a
generic runtime error, Choose model was available, and Send stayed disabled.
The normal standalone attachment picker had an enabled **Open** control and
selected `acceptance-note.txt` through an ordinary click. The draft and attachment
remained in the composer. Exporting the empty-state screenshot used the native
Save panel; an immediate accessibility readback confirmed that focus returned
to the app.

The native GGUF import picker selected the verified regular-profile Qwen file
using its enabled **Open** control and an ordinary click. Import completed
without an app restart, retaining the draft and attachment and enabling Send.
Independent full-file hashing of the new profile's **2,740,937,888-byte** cache
matched the catalog digest
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
This verifies import integrity. A separate R8 short calibration measured
**15.2 tokens/sec**, using **Metal**, **8,192 context tokens** and **Automatic**
memory mode. R7's separate 28.9 tokens/sec measurement retains its own run;
neither short speed sample establishes sustained performance or Agent quality.

After switching to Chat and removing the attachment, the exact prompt
**What is 6 × 7? Reply with only the number.** produced only **42**, with **zero
tool calls or approvals**. Session `5181ae8f-5787-4513-8b5a-5aa3d746d676` saved a
`completed` / `end_turn` outcome at **07:49:10.847 UTC**, using Qwen's verified
digest, Metal, 8K context and Automatic memory mode. A normal quit/relaunch
visibly restored the saved Chat and its exact answer.

The native Create folder flow also passed: its enabled **Create folder here**
control created and selected
`.cache/general-agent-validation/alpha4-r8-dialog-workspace`. The first read-only
Agent task there was cancelled after incorrect-path calls, as recorded below.
The subsequent native Add folder flow selected `general-file-test` through an
enabled **Use folder** control; a separate explicit-path request completed the
readback recorded below.
These native checks used normal system networking.
Read-only provenance is retained in
`.cache/general-agent-validation/alpha4r8-import-chat-readback-audit.json`; the
observer imported no model, operated no UI and modified no profile or task files.

## R8 first attached-file read — incorrect path, then cancelled

Session `e034536c-cce4-4f32-b4c4-5e3db9a84c06` asked the general Agent to read
the attached `acceptance-note.txt` and return its text/tool-reported digest without
editing files or running commands. In the selected `alpha4-r8-dialog-workspace`,
the model used the incorrect relative path
`general-file-test/acceptance-note.txt`. Six read-only tools were recorded:

| Tool | Result |
| --- | --- |
| read_file, incorrect relative file path | Failed: file_unavailable |
| list_files, current workspace | Completed |
| list_files, incorrect relative directory | Failed: file_unavailable |
| inspect_file, incorrect relative file path | Failed: file_unavailable |
| list_files, current workspace | Completed |
| read_file, repeated incorrect relative file path | Failed: file_unavailable |

The user-facing Stop control ended the task at **07:55:55.650 UTC**. The saved
outcome is **cancelled**, with a nonempty **Task stopped** answer, three failed
read/inspection checks, zero passed checks, and no mutation, command or approval.
This remains a model task-quality failure; it is not a successful readback or an
automatic repair. The successful explicit-path request below is a separate task;
it does not reclassify this failed attached-file attempt.

During this actual running task, mouse activation expanded Working, Enter
collapsed it, and Space expanded it again. Actual model thinking remained
visible and expansion persisted through tool updates. A tool card was expanded
and its wrong path and `file_unavailable` result were visibly inspected. These
interaction checks passed independently of the task's failed read results. The
genuine Working screenshot shows expanded model thinking from that unsuccessful
task; it must not be presented as a completed readback.

## R8 separate explicit-path read — completed with evidence

Session `c4e08101-70e1-49fa-8c8a-237462d23ce1` ran in the selected
`general-file-test` workspace. The new prompt explicitly named the absolute
`acceptance-note.txt` path and requested a read-only final text/digest answer.
The model made one `read_file` call with `path=acceptance-note.txt`; the tool
resolved the correct file in that workspace and returned the full **29-byte**
text **Local agents can build tools.**, `eof=true`, and SHA-256
`f6bdd21ecd9728d3da5d9d1a070dba34d204524ba6adf0dde015c44d14a884de`.

The task ended at **07:57:27.829 UTC** with **completed / end_turn**, a **409-byte**
nonempty final answer containing that exact sentence/digest, and **one Passed
read check**. There were no edits, commands or approvals. Actual model thinking
remained expanded (**753 saved UTF-8 bytes**); the completed tool's input and
result were clicked open and visibly verified. The genuine R8 readback capture
below shows the completed tool disclosure. Its saved final answer and exact
tool output were independently inspected read-only.

This pass is limited to the new explicit-path request in the correct workspace.
The earlier cross-workspace attachment attempt remains cancelled/failed. A
narrow R9 instruction change for attachment paths is now packaged and passed its
separate cross-workspace attachment read above. R8 evidence is not renamed R9.

## R7 regular profile audit before migration

The retained R7 app was reopened through its exact executable **without a
user-data override**. The read-only audit found one unique regular main process,
and helper flags consistently identify
`~/Library/Application Support/Local Agent` as its actual profile. Its ASAR hash
matches R7 `f01867ce…90b7`. Visible inspection on **2026-10-13** confirmed the
regular workspace, all five saved tasks, selected Qwen3.5 4B and **Local model
ready** status. The tool-calibration banner remained visible; this startup check
does not establish a new calibrated Agent task.

Compared with the captured baseline, the retained regular `chats.json` is
**byte-identical**, with **5 chats**, their captured messages/attachments/project
paths/settings unchanged, and **6 unchanged undo records**. The full retained
Qwen GGUF is **2,740,937,888 bytes** and independently matches its catalog SHA-256
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
At that earlier audit, the persisted store was **version 3**, before a
save-triggered version-4 rewrite. The new-task screen visibly selected Careful
Agent. That historical v3 snapshot remains separate from the successful final
R9 normal-save migration above; missing v4 fields in the old snapshot were not
treated as zero values.

The separate preview's persisted chats/settings are also byte-identical to their
baseline. Its partial Qwen download remains **156,942,952 bytes**, with current
full-file SHA-256
`6f23f0e409cfcf089b25c473645a41f909d56f47aae28f5a11c1b2237e39e424`.
The original baseline did not contain that partial file's hash. A new independent
full-file recheck on 2026-10-13 matched the preceding independent measurement,
establishing unchanged bytes across those two audits. **The
preview's unsent draft is unverified:** the baseline contains no draft text,
and no live preview process/UI was observed. Persisted-store preservation must
not be described as proof that a transient draft was retained.

Provenance is retained in
`.cache/general-agent-validation/alpha4-r7-independent-preservation-before-regular.json`
and `alpha4r7-final-regular-profile-audit.json`, with the follow-up in
`alpha4-regular-preview-preservation-recheck.json`. These were read-only audits;
they performed no app interaction, profile edits or process signals.

## R7 empty-profile startup follow-up

On **2026-10-13**, the R7 app opened in the genuinely empty
`profile-empty-r7-visible` test profile. The visible interface identified its
separate storage, showed **Download or import your first model** and **Choose
model**, and kept Send disabled. It showed no generic runtime error. The user
draft **What is 6 × 7? Reply with only the number.** and `acceptance-note.txt`
attachment were retained after Choose model opened the full setup screen and
Close setup returned to the composer. No model import or inference was performed.
This native check used normal system networking, with the denied-network
launcher failure retained separately below.

<details>
<summary>Retained R4–R8 package identities</summary>

## Recorded R8 package identity

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| Retained R8 ZIP: `.cache/general-agent-validation/alpha4-r8-artifacts/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip` | 217,115,730 bytes | `ffa45b51dd25a2f0f0d5636aac0b6e438fd884c172ab2e1aa04820f88bee7b81` |
| Retained R8 validation app: `.cache/general-agent-validation/alpha4-r8-artifacts/Free Local Agent Alpha4 Final Validation.app/Contents/Resources/app.asar` | 32,015,464 bytes | `77c9b33b7dca432d13cf171b32beb67b0a9905722b9b85b49a4a4aa96e54340e` |

These full-file hashes were independently read from the archived R8 files after
R9 replaced the delivery path. R8 startup/import/Chat/readback screenshots and
the cancelled attachment attempt remain tied to this retained payload.

## Recorded R7 package identity

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| Retained R7 ZIP: `.cache/general-agent-validation/alpha4-r7-artifacts/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip` | 217,114,537 bytes | `de0560f026408548543ada24a425cc3640113c5793a7c45a52217c8f96b23d8f` |
| Retained R7 validation app: `.cache/general-agent-validation/alpha4-r7-artifacts/Free Local Agent Alpha4 Final Validation.app/Contents/Resources/app.asar` | 32,012,010 bytes | `f01867ceffcb0363cec3a632aa99a33a4ddbbb33762961026a6a5a6fc65890b7` |

These full-file hashes were independently read from the archived R7 files after
R8 replaced the delivery path. The read-only observer's
`.cache/general-agent-validation/native-alpha4r7-evidence.json` reports that R7
ASAR identity and `observerPerformedActions=false`. Persisted-state evidence
does not substitute for visible native task acceptance.

## Recorded R6 package identity

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| Retained R6 ZIP: `.cache/general-agent-validation/alpha4-r6-artifacts/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip` | 217,114,683 bytes | `7f177ea0aff4ccade7203cacd9070124b94fda84883716ef85a80d55e06d3430` |
| Retained R6 validation app: `.cache/general-agent-validation/alpha4-r6-artifacts/Free Local Agent Alpha4 Final Validation.app/Contents/Resources/app.asar` | 32,011,703 bytes | `56a291ada80b3abd71cbbf897fe79c5bb6c40e596f9cdccee140ce36b7c2dfd3` |

These archived sizes and full-file hashes were independently read after the R6
Gemma trial. They identify that recorded payload; they do not identify a later
replacement at the delivery path.

## Recorded R5 package identity

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| Retained R5 ZIP: `.cache/general-agent-validation/alpha4-r5-artifacts/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip` | 217,111,765 bytes | `894d94a50e98ab76a3d0544d4b8aa5c14e2353ac64c5dde154bc708be54a78d6` |
| Retained R5 validation app: `.cache/general-agent-validation/alpha4-r5-artifacts/Free Local Agent Alpha4 Final Validation.app/Contents/Resources/app.asar` | 31,999,443 bytes | `ca368e3731b4632afc43a05dde23b9b46d475a6010528cf45cfbaba2dfa1d41b` |

These sizes and full-file hashes were independently read from the R5 delivery
before replacement. R5 native observations were captured in
`.cache/general-agent-validation/native-alpha4r5-evidence.json`, which reports
the same R5 ASAR and `observerPerformedActions=false`. A capture can include saved
historical chats; only a fresh, payload-bound run establishes new native evidence.

## Recorded R4 package identity

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| Retained R4 ZIP: `.cache/general-agent-validation/alpha4-r4-artifacts/Free Local Agent-0.4.0-alpha.4-arm64-mac.zip` | 217,109,378 bytes | `114a3703fc1d27da483a2f9d0015aa2c6552cd306c3a6b4e36230cb6004e1161` |
| Retained R4 validation app: `.cache/general-agent-validation/alpha4-r4-artifacts/Free Local Agent Alpha4 Final Validation.app/Contents/Resources/app.asar` | 31,988,030 bytes | `0968fd66ebe22d8fbfe347d1c22c8e1581f0a5c879cb5f7649abe9ca2ccd101e` |

Both values were read from the R4 delivery files before the R5 rebuild. These
historical hashes do not identify a future replacement at the same delivery path.
The R4 ZIP was retained as a read-only copy at the path above with the same hash.
The archived native R4 app uses an isolated validation identity/profile and
retains the same R4 ASAR hash. It is not the regular user's app/profile. The macOS package is
unsigned and not notarized. No GitHub release or push is implied by this record.

</details>

The app bundles llama.cpp **0.6.0**, pinned build **11429**, and the offline
source-built Goose **1.53.0** backend. Model weights are separate local downloads
or imports; the app uses its owned loopback inference endpoint with no cloud
fallback or Ollama service dependency.

## Automated checks and their scope

| Check | Result | Scope |
| --- | --- | --- |
| Final R9 app/runtime suite and types | **328/328 passed**, zero failures, skips, or cancellations; TypeScript passed | macOS-enforced public outbound-network denial, localhost allowed. Node test duration **21.248935792 seconds**, whole command **22.80 seconds**. Includes the attachment-path instruction regression; not 328 real-model tasks. |
| Final R9 packaged offline smoke | **Passed**, exit 0, darwin-arm64 | Actual final packaged Electron/ASAR under the same public-network-denial policy; **7.19 seconds**. Runtime pins, offline Goose, actual ACP tools, denial/unchanged fixture and default-off web registration passed. No model loaded/downloaded or public network tool called. |
| Final R8 app/runtime suite and types | **327/327 passed**, zero failures, skips, or cancellations; TypeScript passed | macOS-enforced public outbound-network denial, localhost allowed. Node test duration **23.140854709 seconds**, whole command **24.99 seconds**. Includes native-dialog option/result identity, cancellation/errors, owner/focus and disposal races; not 327 real-model tasks. |
| Final R8 packaged offline smoke | **Passed**, exit 0, darwin-arm64 | Actual final packaged Electron/ASAR under the same public-network-denial policy; **6.94 seconds**. Approval denial left the temporary fixture unchanged; runtime pins, offline Goose, actual ACP tool startup and default-off web registration passed. No model loaded/downloaded, public network tool called, native GUI operation or user-profile mutation. |
| Final R7 app/runtime suite and types | **315/315 passed**, zero failures, skips, or cancellations; TypeScript passed | Rerun under macOS-enforced public outbound-network denial, localhost allowed. Recorded suite duration **20.5651 seconds**. Includes Metal-device retention across experimental RAM refresh. Not 315 real-model tasks. |
| Final R7 packaged offline smoke | **Passed**, exit 0, darwin-arm64 | Also run with macOS public outbound networking denied. Packaged denial/unchanged-file check, runtime pins/hashes/native version, offline Goose manifest, actual ACP tool startup, and default-off web registration. No model loaded/downloaded or public network tool called. |
| R7 Python source suite | **94/94 passed**, exit 0 | **5.19 seconds**; local temporary fixtures and mocked networking. Includes exact module-source reading and existing file/PDF/security checks. |
| R7 frozen-sidecar protocol suite | **8/8 passed**, exit 0 | **4.58 seconds**; tests the already-built native sidecar, including `.mjs/.cjs/.mts/.cts` exact text, BOM/CRLF/Unicode/hash, grants, paging and optional web registration. No GUI or real-model execution. |
| R6 app/runtime suite and types | **314/314 passed**, zero failures, skips, or cancellations; TypeScript passed | Recorded suite duration **20.8806 seconds**. Includes local loopback tests, host-bound deterministic action compaction and policy-deduplication regressions. No OS-enforced public-network-denial claim is made for this archival full-suite run. Not 314 real-model tasks. |
| R6 packaged offline smoke | **Passed**, exit 0, darwin-arm64 | Packaged denial/unchanged-file check, runtime pins/hashes/native version, offline Goose manifest, actual ACP tool startup, and default-off web registration. No model loaded/downloaded or public network tool called. |
| Final R5 app/runtime suite and types | **301/301 passed**, zero failures, skips, or cancellations; TypeScript passed | Recorded suite duration **20.6659 seconds**. Includes local loopback tests and regressions for authoritative host context failures, preserved action context, and recovered allocations. No OS-enforced public-network-denial claim is made for this archival full-suite run. Not 301 real-model tasks. |
| Final R5 packaged offline smoke | **Passed**, exit 0, darwin-arm64 | Packaged denial/unchanged-file check, runtime pins/hashes/native version, offline Goose manifest and actual ACP tool startup. No model loaded/downloaded or public network tool called. |
| R4 app/runtime suite | **291/291 passed**, zero failures, skips, or cancellations | Contract, boundary, recovery, keyboard, markup, runtime and local loopback tests. No OS-enforced public-network-denial claim is made for this archival full-suite run. Deterministic providers/engines are used where appropriate; this is not 291 real-model tasks. |
| R4 packaged offline smoke | **Passed** on darwin-arm64 | Packaged Electron/ASAR bridge denies a write and leaves the project unchanged; runtime pins/hashes/native version and offline Goose manifest verified; actual packaged Goose ACP initializes both local tool servers. |
| Frozen research/mode registration in smoke | **Passed** | File tools registered; web absent by default and available only after explicit enablement in Agent/Research, remaining absent in Chat. No model loaded/downloaded and no public network tool called. |

Local logs:

- `.cache/general-agent-validation/alpha4-full-offline-r9-enforced.log`
- `.cache/general-agent-validation/alpha4r9-packaged-smoke.log`
- `.cache/general-agent-validation/alpha4r9-packaged-smoke-validation.json`
- `.cache/general-agent-validation/alpha4-full-offline-r8-enforced.log`
- `.cache/general-agent-validation/check-r8-typecheck-offline.log`
- `.cache/general-agent-validation/alpha4r8-packaged-smoke.log`
- `.cache/general-agent-validation/alpha4r8-packaged-smoke-validation.json`
- `.cache/general-agent-validation/alpha4-full-offline-r7-enforced.log`
- `.cache/general-agent-validation/alpha4r7-package.log`
- `.cache/general-agent-validation/alpha4r7-packaged-smoke.log`
- `.cache/general-agent-validation/alpha4-r7-python-validation.json`
- `.cache/general-agent-validation/alpha4-full-offline-r6.log`
- `.cache/general-agent-validation/alpha4-package-final-r6.log`
- `.cache/general-agent-validation/alpha4r6-packaged-smoke.log`
- `.cache/general-agent-validation/alpha4-full-offline-r5.log`
- `.cache/general-agent-validation/alpha4-package-final-r5.log`
- `.cache/general-agent-validation/alpha4r5-packaged-smoke.log`
- `.cache/general-agent-validation/alpha4-full-offline-r4.log`
- `.cache/general-agent-validation/alpha4-package-final-r4.log`
- `.cache/general-agent-validation/alpha4r4-packaged-smoke.log`

Automated success verifies the tested implementation contracts. It does not
establish native interaction with every control, sustained speed, huge-model
memory fit, or the quality of a model's generated project.

The final R7 full-suite offline result uses `sandbox-exec` with the retained
`offline.sb` policy: outbound networking is denied except localhost. The earlier
R7 run's 20.8325-second result was not wrapped by that OS policy and is not used
as the final offline evidence. The enforced rerun changed no source or app
payload; the retained R7 ZIP/ASAR identities above remain unchanged.

**Scope separation:** the real-model native Qwen tasks/Chat, Gemma trials and
visible graphical interactions ran with normal system networking available. Their local
execution evidence does not establish a real-model native UI run under enforced
public-network denial. That denial was enforced for the final contract suite,
packaged smoke and the separate actual real-model component check below; the
smoke loaded no model. The attempted denied-network
native launcher below failed before UI and leaves that acceptance unverified.

## R9 real-Qwen component execution with public networking denied

At **08:26:11.569–08:26:39.630 UTC** on 2026-10-13, the current R9
runtime/gateway/backend source at **`b7a72d2`** ran the **actual final packaged
llama.cpp, Goose and frozen file reader** under the unchanged macOS `offline.sb`
policy. Public outbound networking was denied; localhost remained available.
This used a fresh private runtime and real Qwen weights, with no synthetic
provider, model download, saved-chat or existing-profile modification, or GUI interaction.
The verified Qwen digest remained `00fe7986…11a4`.

The effective profile was **Automatic / Metal**, **8K context**, **2,048 output
tokens**, **batch 512**, **microbatch 128**, **one loaded model and one slot**.
The native token-count endpoint returned **280, 510, 1,605 and 2,129** input
tokens for its four input-token calls. A separate short tool-calibration sample measured
**36.536148 tokens/sec**; it is independent of the GUI's 11.1/15.2/28.9 samples
and establishes neither sustained speed nor model quality.

| Actual component result | Evidence |
| --- | --- |
| Ordinary Chat | Exact two-byte **42**, `end_turn`, zero tools. |
| Read-only Agent attachment | One actual frozen-MCP read of an individually granted absolute path outside the empty workspace; complete **57-byte** unpredictable fixture text and matching final answer, `end_turn`. |
| File integrity and effects | Receipt digest `c3ca593a4de3f2ee7b830630bb4545aaff6f45ed812060a83c42de04ea4077f0`; fixture unchanged, workspace still empty, zero actions/approvals. |
| Shutdown | All owned native children exited; no cleanup errors. **28.061 seconds** recorded execution, **29.63 seconds** whole command. |

**The original private harness exited 1**, and its JSON still records
`passed=false`: its display-title assertion expected `read_file`, while the
actual ACP title used **read file**. The real Chat, tool input/receipt and final
answer had already completed. A corrected future matcher and independent
**read-only post-validation of those existing results** confirmed the actual
checks passed, including exact text/digest, no effects and child cleanup. No
model task was replayed or reloaded to obtain that post-validation; the original
failure is preserved.

Private evidence remains in
`.cache/general-agent-validation/alpha4r9-real-model-offline.json`, its unchanged
`.log`, and `alpha4r9-real-model-offline-independent.json`. This is **real-model
offline component execution using R9 source and packaged binaries**, not full
Electron GUI offline acceptance. The separate exit-133 nested-GUI harness failure
below remains unverified within its own scope. Package/source identities and all
earlier native task/model results are unchanged.

## Qwen3.5 4B — R7 Node CLI repair independently passed

Session `8c7f5065-fb63-4109-9539-39705d0a8763` used the general Careful Agent in
the existing `alpha4-node-cli` workspace. It inspected and read the existing
`stats-cli.mjs`, repaired the `parsed` scope error through **one normal approved
edit**, ran **one normal approved four-case verification command**, and read the
final source. No observer repaired the artifact. The app's approved repair
action is `cc77134b-7c84-498c-9ead-f42a95f7fcff`; the verification command is
`93638657-be56-4b85-91bc-a2d073ca2580` and returned exit **0**.

The repaired source is **1,214 bytes**, SHA-256:

```text
7145c5bada70a7894ca9b96f1dc6512a28691db7327c062dc08dd0863fe9c346
```

An independent Node **v26.7.0** check ran at **15:32:06 UTC** without modifying
the source. Its before/after hashes matched the approved edit receipt and all
**four required cases passed**:

| Input | Verified result |
| --- | --- |
| `[1,2,3,4]` | Exit 0; count 4, sum 10, min 1, max 4, mean 2.5. |
| `[]` | Exit 0; count 0, sum 0; min, max and mean null. |
| Malformed `[1,2` | Exit 1 with `Error: Invalid JSON format`, no stdout. |
| Nonnumeric `[1,"two",3]` | Exit 1 with `Error: All items must be finite numbers`, no stdout. |

Evidence is retained in
`.cache/general-agent-validation/stats-cli-r7-validation.json`, bound to final
R7 ASAR `f01867ce…90b7`. The saved session finalized at **15:34:28.491 UTC** with
`completed` / `end_turn`, a **1,255-byte** nonempty final answer, the approved
edit/command checks, and final readback. **Visible terminal completion was
confirmed**: New task became available and the final answer/readback/outcome
was visible. Genuine File-menu captures show the live expanded Working and final
CLI result; hashes are recorded below.
This separate repair does not reclassify the failed R4/R5 attempts or the failed
built-in model validation. It verifies this CLI artifact and these four cases,
not general task correctness. The fixture is absent from production prompts/tools.

## Qwen3.5 4B — R7 exact file, retained readback and ordinary Chat

The fresh exact-file session `585dd9c3-3aad-4e28-bf51-f0381a601468` created
`exact-note.txt` containing precisely `Alpha beta` without a newline, read it,
used a real `edit_file` replacement `beta` → `gamma`, and read the final file.
Two normal approvals covered creation and edit; no commands ran. The requested
**create → read → exact edit → read** sequence passed. Independent byte reading
confirmed **11 bytes**, exactly **`Alpha gamma`**, no newline, SHA-256:

```text
acbc86df4f256fc8eb50a572a910ccb02f356cc9997cdbb9730b097f1976daeb
```

The model first probed the absent file with `read_file`, which returned
`FILE_NOT_FOUND`. That initial failure remains recorded alongside the four
passed sequence checks: **five tool calls, four passed checks and one failed
pre-creation probe**. The saved outcome is `completed` / `end_turn` at
**15:40:11.329 UTC**, with a **403-byte** nonempty final answer containing the
verified content/hash. The model's blanket success sentence does not erase the
earlier failed probe. Unlike the historical R4 task, this request specified the
exact text boundary, and the requested final bytes were established.

Read-only session `226b63da-2eb5-482d-965e-7832226bbaa5` then read the retained
`acceptance-note.txt` once, with **no new creation, edit, command or approval**.
Its final answer visibly contains **`Local agents can build tools.`** and SHA-256
`f6bdd21ecd9728d3da5d9d1a070dba34d204524ba6adf0dde015c44d14a884de`.
Independent reading confirmed **29 bytes** with no newline. It completed with
`end_turn` at **15:42:36.629 UTC**, a **160-byte** final answer and one passed
readback check. This closes the retained-file acceptance through a fresh request;
it does not replay or reclassify the earlier failed edit turn.

Ordinary Chat session `c541fac4-c66b-444c-a9fb-4989984d7693` asked
“What is 6 × 7? Reply with only the number.” It visibly answered exactly **`42`**
and saved `completed` / `end_turn` at **15:43:44.193 UTC**, with **zero tool
calls, checks or approvals**. The genuine capture uses **125% text scale**.
After a graceful app quit and relaunch of the same final R7 app/profile, the saved
Chat was selected and visibly showed **`42`**, **Chat** mode and the retained
**125%** text setting, with no approval panel. The quit exited **0**. The scale
was then restored to **100%** through the normal text-size control. This verifies
that Chat and preference persistence across reopening, without resending the
prompt or calling tools.

## Qwen3.5 4B — final R4 built-in task validation

Hardware: Apple M5, **24 GiB** unified memory, macOS ARM64. Model:
`qwen3.5:4b`, Q4_K_M. Model digest:
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
Chat-template hash:
`7f0e529032c25183bcd66c7f238da2d377f43be754a94e2725a58c4e16d2ed67`.

The recorded effective profile was **Automatic**, **Metal**, **8,192 context
tokens**, **2,048 output tokens**, **batch 256**, **microbatch 64**, and **one
slot**, bound to engine commit
`d81235049384534c167caea52b85a694f6103d14`. Allow slow mode was enabled in the
isolated profile. The task used Careful Agent with file tools and normal approval;
terminal and web research were disabled.

Validation record: `0ae7de88-fa2a-4f86-94d3-567db45e80cf`.
Session: `dfa2581e-3db0-4e95-a141-96865f40a6a6`.
Started **13:05:34.580 UTC**, completed **13:07:52.034 UTC**. Recorded elapsed
time: **137,454 ms**, including validation/preparation and approval overhead; this
is not a tokens-per-second benchmark.

**Overall model-validation result: Failed.** The app's saved outcome is **blocked**,
with a nonempty 465-byte closing answer identifying the exact-edit blocker.

| Recorded acceptance check | Result | Evidence |
| --- | --- | --- |
| Ordinary Chat | Passed | Exact response `42` to the short arithmetic probe. |
| Native tool format | Passed | Local native tool-call calibration succeeded. |
| Exact create/read/edit/read sequence | **Failed** | One approved creation and two successful reads; both requested edits failed, and expected final bytes were never produced. |
| Model/profile identity | Passed | Prepared digest, runtime and effective profile matched the task. |
| Successful final answer | **Failed** | The task was blocked, although a nonempty and explicit blocker answer was saved. This is not an empty-answer failure. |
| File-only validation | Passed | No terminal tool called. |

The created file was exactly **24 bytes**, with a real trailing LF (`0a`):

```text
Local validation first.
```

Its SHA-256 remains
`b4472f35c4307e5e6bbeebfa9d5349e3541ba0b3fedb9811114499bda9e86665`.
The model supplied a **25-byte** `old_text` ending in literal backslash-plus-`n`
(`5c6e`). That differs from the source newline. The first edit returned
`TEXT_NOT_FOUND`; the second identical edit against the unchanged file returned
`REPEATED_EDIT_FAILED`. Both reported `changed=false`. The turn stopped before
further mutation; completed creation and its undo record were preserved.

This is a model argument mismatch, not evidence that the app stripped or
normalized the source text. Successful creation/read receipts do not turn this
failed requested sequence into a task pass. A later successful separate request
must retain its own evidence and cannot reclassify this validation record.

The read-only observer reported `observerPerformedActions=false`. Evidence is
stored locally in `.cache/general-agent-validation/native-alpha4r4-evidence.json`
and the isolated profile. The independent byte audit read the existing file; it
did not repair it or execute project commands.

## Qwen3.5 4B — R4 Node CLI attempt failed

Session `567dd419-3b91-4a51-92be-119e58fc8fa6` requested a dependency-free
`stats-cli.mjs`, a source read, and approved tests for numeric, empty, malformed,
and nonnumeric JSON inputs. It ran in the app-created
`.cache/general-agent-validation/alpha4-node-cli` workspace with Careful Agent.
The saved model identity was the same Qwen digest, Automatic/Metal, 8K context.
The session finalized at **13:25:36.650 UTC**.

**Result: Failed, not a working CLI.** Normal approvals allowed `node --version`
(**v26.7.0**), source creation, `ls -la`, and the numeric-input test. The source was
**1,208 bytes**, SHA-256
`dff7ee645ad95250cd73db702ec9d2048d7beef3320e3a5d708094dd83faec98`.
Two `read_file` calls and one `inspect_file` call rejected `.mjs` as unsupported
in the R4 sidecar. A later `write_file` proposed the same bytes and returned
`changed=false`; it did not repair the program or create another mutation.

The approved command `node stats-cli.mjs "[1,2,3,4]"` exited **1**, with
`ReferenceError: parsed is not defined` at line 28. The generated code declared
`const parsed` inside a `try` block and then referenced it outside that scope.
The valid numeric case did not produce the expected JSON. Empty/malformed/
nonnumeric acceptance was not established. The read-only documentation audit
read the saved source/log; it did not run or repair the CLI.

**R4 outcome-classification defect:** later context processing returned HTTP
**400**, `Required context still does not fit after compaction`. Goose surfaced
that error as assistant text with `end_turn`; the saved host outcome incorrectly
said `completed`. That status is not a task pass. The assistant error and failed
numeric command remain recorded. This exposed an application classification
defect separately from the model's code error and the sidecar suffix gap.

## R5 Node repair attempt — blocked context preserved

R5 added `.mjs/.cjs/.mts/.cts` source reading and made host inference failures
authoritative for task outcomes. Native session
`c9e88161-87d2-4eee-b1c4-08b85fb90641` successfully read the existing module, but
its proposed edit returned `TEXT_NOT_FOUND`, `changed=false`. Subsequent context
processing failed; the saved outcome was correctly **blocked**, with a nonempty
**614-byte** answer at **14:41:40.607 UTC**. The source retained its R4 hash
`dff7ee64…ec98`; that attempt did not repair or rerun the program.

R6 then removed duplicated app instructions and added deterministic compaction
for closed actions bound to actual host receipts. Current requests and
latest/pending tools remain exact; saved raw records, denied/error states, file
hashes and command-log pointers remain available. Compaction never replays an
action. Automated regressions cover those boundaries; the R7 repair above is
separate real-model evidence.

Actual native runs used `.cache/general-agent-validation/profile`, an isolated
validation profile. A planned `profile-r5` clone was unused for app actions.
The validation app retained a bundle identity ending in `r4` while its payload
was replaced; archived R4/R5/R6 artifacts preserve each ASAR identity. App name,
bundle ID, copied chats and historical screenshots cannot establish a new
payload's acceptance. Neither profile is the regular user's store.

## Gemma 4 26B A4B — integrity passed, R7 loading stopped

The pinned **Gemma 4 26B A4B**, QAT Q4_0 download completed through the app,
including the earlier cancel/resume path. The artifact is **14,439,363,584 bytes**
(approximately **13.45 GiB** or **14.44 GB**), revision
`d1c082be9cf3c8a514acf63b8761f4b41935842e`. Independent full-file hashing completed
at **14:49:18.077 UTC** and matched the catalog pin:

```text
3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d
```

Integrity provenance is retained locally in
`.cache/general-agent-validation/gemma26-integrity-alpha4.json`. That successful
download/hash is separate from runtime compatibility or model quality.

The **final R7** app ran a new explicit **Try Experimental disk mode** on the
**24 GiB Apple M5**. **Result: watchdog stopped loading before properties, Chat,
native tools, or Agent checks.** The actual UI reported:
“Experimental disk mode stopped because the model reached its sampled
resident-memory budget.” No model-quality result was produced.

The independent read-only observer verified that the engine belonged to the
approved validation app, matched the exact Gemma GGUF path, and used **CPU-only
(`--device none`, zero GPU layers), 4K context, batch 128, microbatch 32, F16 KV,
mmap, lazy mode on, fitting off, one slot and offline loopback inference**.
Engine agent tools, web UI, prompt/idle cache and context shift were disabled.
These observed flags establish the launched configuration, not lazy eligibility
for every weight or expert.

| Last app-owned measurement | Value |
| --- | --- |
| Last resident sample | **6.86 GiB**, rounded |
| Resident stop threshold | **6.86 GiB**, rounded |
| Last available sample | **7.62 GiB**, rounded |
| Memory pressure | **Normal** |
| Mapped bytes, lazy-eligible bytes, app peak resident value | **Unknown** |
| Chat, native tools, Agent checks, inference speed | **Not reached** |

App samples and independent samples are separate measurements. The external
observer recorded two owned-process RSS samples:

| UTC sample | Resident bytes | Available bytes | Pressure |
| --- | --- | --- | --- |
| **15:49:14.694** | **5,041,635,328** | **8,253,505,536** | Normal |
| **15:49:16.698** | **7,341,031,424** | **8,213,741,568** | Normal |

The maximum of these samples was **7,341,031,424 bytes** (about **6.84 GiB**),
and the owned process exit was observed at **15:49:18.696 UTC**. This is a sampled
maximum, **not an absolute peak or a hard cap**. The app's two-decimal display
does not reveal the exact threshold comparison. A sample can reach or exceed
the threshold before termination. Public networking, unrelated processes and
swap settings were not changed by the observer.

Provenance is retained in
`.cache/general-agent-validation/gemma26-r7-trial-validation.json` and
`gemma26-r7-resource-samples.json`, bound to final R7 ASAR `f01867ce…90b7`.
Neither resource observer rehashed the weights; the independent completed
integrity record above supplies that separate evidence. The trial retained the
verified weights. After changing to **Automatic**, the actual UI retained Metal,
selected Qwen3.5 4B, and returned to ready **Metal / 8,192 context** inference;
the displayed **28.9 tokens/sec** calibration was verified again.

![Final R7 Gemma loading stopped at the sampled memory budget](screenshots/free-local-agent-alpha4-gemma-trial-r7.png)

*Genuine unchanged final R7 File-menu capture. Binary memory quantities are
labeled GB in the UI; this report expresses them in GiB. SHA-256:
`e579d61df939f32b19d6e4cf1bf035d862881acba9d0571d82d9182df85a349b`.*

This is a verified safety-stop outcome under that trial's available memory,
not a successful load or a claim that Gemma cannot run on every 24 GiB computer.
No Gemma Chat/tool/task pass, sustained speed, absolute peak, lazy-tensor coverage,
or frontier-model quality is claimed.

<details>
<summary>Earlier R6 trial: separate loading stop and app samples</summary>

The R6 packaged app then ran **Try Experimental disk mode** on the current
**24 GiB Apple M5**. The CPU-only trial used mapped weights, 4K context, batch
128, microbatch 32, and the app's sampled memory watchdog. **Result: loading
stopped before properties, Chat, or native tool probes.** The app reported:
“Experimental disk mode stopped because the model reached its sampled
resident-memory budget.”

| Last app-owned measurement | Value |
| --- | --- |
| Resident memory | **5.31 GiB** |
| Resident stop threshold | **4.75 GiB** |
| Available memory | **4.33 GiB** |
| Memory pressure | **Warning** |
| Mapped bytes, lazy-eligible bytes, peak resident memory | **Unknown** |
| Chat, native tools, task quality, inference speed | **Unverified; probes did not run** |

An earlier app sample showed 4.02 GiB resident and 4.16 GiB available. These are
the app-owned monitor readings observed in the real UI. They are not an
independent peak-memory benchmark. The external read-only observer started
after the short-lived model process window and did not observe that engine;
its independent peak and exit measurements remain unknown. Provenance and that
limitation are preserved in
`.cache/general-agent-validation/gemma26-r6-resource-samples.json`.

![R6 native Gemma loading stopped at the sampled resident-memory budget](screenshots/free-local-agent-alpha4-gemma-trial.png)

*Genuine R6 app capture, ASAR `56a291ad…dfd3`. The UI labels these binary memory
quantities as GB; the report expresses them in GiB. R7 retains that unit-label
limitation and clarifies the stopped values as last samples. The screenshot is
unchanged. Its SHA-256 is
`a76341f507f21f41b1e018f83d061686c475dd5be8943b56875d6997be214900`.*

The safety stop preserves the downloaded weights and permits a later explicit
trial. It does not establish that this model can run at the measured available
memory or on every 24 GiB computer. No Gemma task pass, sustained speed,
lazy-weight coverage, or huge-model usability is claimed.

</details>

## R7 runtime and native interaction checks

R7 retains the separately verified Metal/Vulkan accelerator descriptors when an
experimental trial refreshes RAM and disk measurements. Returning to Automatic
can therefore choose the detected accelerator instead of losing GPU discovery
during a CPU-only trial. The experimental launch itself remains CPU-only. Its UI
also labels retained measurements as **Last resident sample** and **Last available
sample**. Chat and tool-format readiness remain separate runtime conditions;
the trial heading itself still says **Load and probe passed**. Binary
quantities are still labeled GB in the UI. Source review found no new approval,
replay, receipt, or deadline regression; the suite/package checks above passed.
The successful separate Qwen repair does not reclassify the failed Gemma
trial or the historical Qwen failures.

R7's Qwen3.5 4B native calibration measured **28.9 tokens/sec** on **Metal** with
**8,192 context tokens**. The app returned to a working task screen after
calibration. During the live CLI-repair session
`8c7f5065-fb63-4109-9539-39705d0a8763`, mouse, Enter and Space visibly collapsed
and expanded Working with real thinking and tools retained. These checks establish
calibration and interaction behavior. The CLI's four independent checks and saved
completion, fresh-file/ordinary Chat and Chat-reopen results are recorded above.
R7 empty/regular-profile startup passed the visible 2026-10-13 follow-up above.
R8's setup/import, Chat/reopen and dialog checks passed separately above. Its
first read-only task was cancelled after incorrect-path failures; the separate
explicit-path request in the correct workspace passed within the scope recorded
above.

## Qwen3.5 4B — separate R4 file-operation sequence

Session `d48b2462-84b0-42eb-bc39-9af8896a6689` completed at
**13:15:31.548 UTC** with `end_turn` and a nonempty final answer. It used the same
Qwen digest, Automatic/Metal 8K profile, and Careful Agent in the isolated
workspace, as a separate task rather than a rerun of the failed validation record.

The real ordered tools were **create_files → read_file → edit_file → read_file**.
Two normal approvals settled immediately. Exactly one creation and one edit were
recorded; all four operation checks passed, with no extra actions. The precise edit
arguments were `old_text=beta` and `new_text=gamma`. Final readback and independent
bytes were **11 bytes**, **`Alpha gamma`**, with **no newline**, SHA-256:
`acbc86df4f256fc8eb50a572a910ccb02f356cc9997cdbb9730b097f1976daeb`.

**Scope: the approved operations and actual readback passed.** The creation request
contained unquoted `Alpha beta.` followed by prose; the model created `Alpha beta`
without the period. This exposes a text-boundary ambiguity/model omission. If the
period is an intended byte requirement, that requirement was not met. This record
does not claim every semantic requirement passed, and it does not reclassify the
failed built-in validation. Its genuine R4 captures are retained below. Reopening
this historical R4 session was not established; the R7 Chat reopen and
fresh exact-file acceptance passed separately above, with no outstanding Chat
check.

## Native interface results

| Check | Result | Payload scope |
| --- | --- | --- |
| Granted attachment outside selected workspace | Passed visibly and persisted | Final R9 `0b18cc0a…`: actual absolute-path read, one Passed check, complete 29-byte text/digest and 465-byte final answer; no edits/commands/approvals. Thinking/tool disclosure and final answer separately captured. |
| Fresh Chat exact `42` and normal reopening | Passed visibly and persisted | Final R9 `1b8340f0…`: completed end_turn, two-byte answer, no tools/approvals; normal quit/relaunch restored saved `42`, Chat and 100% text size without replay. |
| Regular profile restore and saved v4 migration | Passed visibly and independently compared | Final R9, no profile override: five original full sessions and settings retained except version, no new messages/sessions, six full undo hashes and Qwen digest unchanged. Normal main-process task-effort preference save triggered v4. |
| Regular speed/tool calibration and ready workspace | Passed visibly; 11.1 then 11.0 tokens/sec | Final R9 regular profile, Metal/8K/Automatic; preparation passed again after the final reopening, calibration banner gone, dark/100%/Careful screen restored. Separate short samples, not task-quality acceptance. |
| Empty startup, attachment and GGUF import | Passed visibly, import cache hash independently matched | Final R8 fresh profile: no generic engine error; enabled native Open controls worked by ordinary clicks. Import retained draft/attachment, enabled Send and required no restart. |
| Ordinary Chat exact `42` and reopen | Passed visibly and persisted | Final R8 `5181ae8f…`: zero tools/approvals, completed end_turn; normal quit/relaunch restored Chat and `42`. |
| Screenshot export and focus restoration | Passed visibly | Final R8 native Save panel exported the empty-profile capture; immediate accessibility readback confirmed return to the app. |
| Native Create folder and Add folder selection | Passed visibly | Final R8 created/selected `alpha4-r8-dialog-workspace` through enabled Create folder here; later selected `general-file-test` through enabled Use folder. |
| Working mouse / Enter / Space and tool disclosure | Passed visibly | Final R8 `e034536c…`: actual model thinking, retained expansion through updates, wrong read path/result inspected. This was an unsuccessful read task, not a task-quality pass. |
| First attached-file read task | Failed readback, then cancelled | Final R8 `e034536c…`: six read-only tools, wrong relative path, repeated file_unavailable, explicit stopped answer; no mutation/command/approval. Separate pass does not change this result. |
| Separate explicit-path readback | Passed visibly and persisted | Final R8 `c4e08101…`, correct workspace: one completed read, one Passed check, 409-byte final text/digest answer; no edits/commands/approvals. Expanded thinking and tool disclosure verified. |
| Qwen speed sample | Measured 15.2 tokens/sec | Final R8, Metal/8K/Automatic; separate from R7's 28.9 sample. Short calibration, not sustained project performance. |
| Qwen calibration and Metal readiness | Passed visibly; 28.9 tokens/sec measured | Final R7 alpha.4, 8K context. Short calibration; not a sustained project-quality benchmark. |
| Node CLI repair and four input checks | Independent 4/4 passed; completed final answer/readback visibly confirmed | Final R7 alpha.4 session `8c7f5065…`; one approved edit/command. Genuine captures below. |
| Working mouse / Enter / Space expansion | Passed visibly during live CLI repair | Final R7 alpha.4 session `8c7f5065…`; actual thinking/tools retained. |
| Exact create/read/edit/read task | Passed for requested sequence and exact bytes | Final R7 `585dd9c3…`; two approvals, 11-byte `Alpha gamma`, final answer. Initial missing-file probe remains failed evidence. |
| Retained note readback | Passed visibly | Final R7 `226b63da…`; one read, no new mutation/command/approval; exact requested sentence/hash. |
| Ordinary Chat exact `42` and reopen | Passed visibly, saved and restored | Final R7 `c541fac4…`; zero tools/approvals; graceful quit/relaunch restored `42`, Chat mode and 125% text scale without replay. |
| Gemma experimental loading and return to Qwen | Verified safety stop, probes not reached; Qwen fallback ready | Final R7; owned CPU-only process independently observed, watchdog stop visible, Metal/Qwen readiness retained after Automatic. |
| Regular profile process and retained data | Passed visible startup and read-only preservation | Historical R7 follow-up on 2026-10-13: regular workspace, five tasks, selected Qwen and Local model ready shown; 5 chats/6 undo/full Qwen hash retained in the pre-migration audit. Final R9 calibration and v4 migration passed separately above. |
| Empty-model startup and setup return | Passed visibly | R7 fresh profile on 2026-10-13: separate storage identified, Choose model available, no generic runtime error; draft/attachment retained after opening/closing setup, Send disabled. No import or inference run. |
| Task activity mouse collapse / Enter expand | Passed visibly | Final R4. Thinking and tool tree disappeared and reappeared. |
| Space collapse / Space expand | Passed visibly | Final R4. Nested `read_file` remained expanded with exact text and SHA evidence. |
| Approved creation/edit and final file readback | Passed for the actual operations | Final R4 separate task `d48b2462…`; four ordered tools, two approvals, exact final hash and nonempty answer. Period-boundary limitation described above. |
| Retained `acceptance-note.txt` readback | Passed on an earlier alpha.4 payload | One read, no new mutation, nonempty answer; exact retained bytes/hash. Not promoted to final R4 acceptance. |
| Ordinary Chat exact `42`, no tools | Historical earlier-payload pass | A separate R4 repeat was not established. Current final R7 Chat and reopen passed above; no outstanding Chat check. |
| Native Create folder and workspace selection | Passed | Final R4: New task → Create folder → native parent picker created and selected `.cache/general-agent-validation/alpha4-node-cli`. Independent read found the new folder empty at the check. This does not establish a running Node project. |
| Screenshot export | Passed | Final R4: File → Save screenshot used the app's own capturePage. Original PNGs show expanded thinking and the final answer/outcome; no mocked conversation or image alteration. |
| Text-scale choice and Chat reopen | Passed visibly | Final R7; 125% survived graceful quit/relaunch, then normal controls restored 100%. Other native preference choices retain their individual automated-check scope. |

![Final R9 expanded thinking and absolute-path attachment read](screenshots/free-local-agent-alpha4-tools-r9.png)

![Final R9 collapsed activity and exact final text/digest answer](screenshots/free-local-agent-alpha4-final-readback-r9.png)

![Final R9 ordinary Chat exact answer](screenshots/free-local-agent-alpha4-chat-r9.png)

![Final R9 ready regular profile after saved v4 migration](screenshots/free-local-agent-alpha4-regular-profile-r9.png)

These genuine R9 captures were independently inspected and hashed. The first
shows actual model thinking and the completed tool's absolute-path input outside
the selected workspace. The second shows the actual final sentence/digest with
Task activity collapsed. The third shows the exact Chat answer and completed
outcome without recorded tool checks. The fourth shows the restored regular
profile after migration and calibration, with the five original tasks and no
calibration banner. They identify R9 ASAR `792ccb20…8bb8`; earlier R8/R7
captures below keep their original payload identity.

| R9 PNG | SHA-256 |
| --- | --- |
| `free-local-agent-alpha4-tools-r9.png` | `dc8c9049064362a6eb5930740a22d0c65bbe0fdbba2a9b0e332ee86e0ab38691` |
| `free-local-agent-alpha4-final-readback-r9.png` | `b0115ab97bc836e5f3e22c0db1378740b376fd26fd04a7b788ec998183efbe62` |
| `free-local-agent-alpha4-chat-r9.png` | `3d0320d3a4ebf6acbb4002dd82d131adcbb457ff4925709070520f8c3310da96` |
| `free-local-agent-alpha4-regular-profile-r9.png` | `29f9e763c70756b0dc794eec1bd4e7aa06973c9f6910118fa8783296fff0d553` |

![Final R8 genuinely empty profile with draft and attachment](screenshots/free-local-agent-alpha4-empty-model-r8.png)

![Final R8 Chat after verified local-model import](screenshots/free-local-agent-alpha4-chat-r8.png)

![Final R8 Working during the unsuccessful attached-file read](screenshots/free-local-agent-alpha4-working-r8.png)

![Final R8 completed file read with expanded input/result](screenshots/free-local-agent-alpha4-readback-r8.png)

These genuine R8 screenshots were independently inspected and hashed. The first
shows Choose model, retained draft/attachment and disabled Send before import.
The second shows the exact `42` answer, Chat mode, completed outcome and zero
recorded operation checks. The third shows actual model thinking and expanded
Working during the failed first read task. The fourth shows the separate completed
read's expanded thinking and tool disclosure. All retain R8 ASAR `77c9b33b…340e`
provenance; the R7 Agent-task captures below keep their original identity.

| R8 PNG | SHA-256 |
| --- | --- |
| `free-local-agent-alpha4-empty-model-r8.png` | `889ba2e2e77a829acb05452117967855e4958680897a4c87328420b2f4345dc4` |
| `free-local-agent-alpha4-chat-r8.png` | `662acf69dd3a82e924737599a5c789d549a56a02f0484bc09f8cb635aa8eab5a` |
| `free-local-agent-alpha4-working-r8.png` | `0167b6eff3e55885bd143459bb427ff97d55d9f0c4f3e8267a59a8804a034001` |
| `free-local-agent-alpha4-readback-r8.png` | `b5c93922cd3d3b6c378d0a705c1efd7fd8c726d1890c75071e9c59255a2098f5` |

![Final R7 live Working expanded during the CLI repair](screenshots/free-local-agent-alpha4-working-r7.png)

![Final R7 completed CLI answer and final source hash](screenshots/free-local-agent-alpha4-cli-r7.png)

Both are unchanged File-menu captures from final R7 ASAR `f01867ce…90b7`.
The first shows the real running task's model thinking and retained activities;
the second shows its verified source hash, completed answer and recorded checks.

| R7 PNG | SHA-256 |
| --- | --- |
| `free-local-agent-alpha4-working-r7.png` | `40421c59dd69d2ec80d8d2b445eacdf7b2c2b25f06e0869f8c101acab14641ab` |
| `free-local-agent-alpha4-cli-r7.png` | `f331237b53b6d17dc832e411507f60848c894393966c0a47c546a3bb3be2d25a` |

![Final R7 exact-file final readback and answer](screenshots/free-local-agent-alpha4-exact-readback-r7.png)

![Final R7 read-only retained-file answer](screenshots/free-local-agent-alpha4-note-r7.png)

![Final R7 ordinary Chat at 125 percent text scale](screenshots/free-local-agent-alpha4-chat-r7.png)

These unchanged final R7 File-menu captures were inspected and hashed. The
exact-file capture shows the final source hash and answer; its initial failed
probe is retained in the saved evidence rather than hidden. The note capture
shows the requested read-only sentence/hash. The Chat capture shows `42`, zero
recorded tool evidence and the larger text setting.

| R7 PNG | SHA-256 |
| --- | --- |
| `free-local-agent-alpha4-exact-readback-r7.png` | `88b0f12d812f52717fd6208b48945aca4ab337376e308c32cffaa334f8ca2dfa` |
| `free-local-agent-alpha4-note-r7.png` | `c7f3190e58ad792a943404662c65a1f710ab4a5657c97016dc427c81abe59d22` |
| `free-local-agent-alpha4-chat-r7.png` | `9004c119bc14af1961f6c6d994cab07964b0a916aa284644c6b62223be1a3a3d` |

![R7 regular profile after visible reopening](screenshots/free-local-agent-alpha4-regular-profile-r7.png)

![R7 genuinely empty profile after returning from model setup](screenshots/free-local-agent-alpha4-empty-model-r7.png)

These genuine 2026-10-13 R7 captures were independently inspected and hashed.
The regular capture shows the five retained tasks, workspace and selected Qwen,
with the separate tool-calibration banner still present. The empty-profile
capture shows the preserved draft and attachment, Choose model and disabled Send.

| R7 startup PNG | SHA-256 |
| --- | --- |
| `free-local-agent-alpha4-regular-profile-r7.png` | `3fca912313a09459608accd8b5d235ab47c41339dcb6ffc4d0394f42a8fc01ac` |
| `free-local-agent-alpha4-empty-model-r7.png` | `1beba1ea888390ae39c45cb052ff9a2a4c6b4f21b2a4b1dbd262287fa92179d6` |

<details>
<summary>Historical R4 file-task captures and earlier payload evidence</summary>

![Final R4 native file task with expanded model thinking](screenshots/free-local-agent-alpha4-file-task.png)

*Actual R4 isolated-profile task `d48b2462…`, with Task activity expanded and
four activities retained. The app shows model-supplied thinking; that thinking
is tentative, and the saved task has the period-boundary limitation above.*

![Final R4 native answer and recorded operation checks](screenshots/free-local-agent-alpha4-final-answer.png)

*Actual R4 answer/outcome view. The UI says **Recorded checks passed** for four
operations and asks the user to review whether the result fulfills the request.
It does not label the whole task verified.*

Both captures come from payload ASAR
`0968fd66ebe22d8fbfe347d1c22c8e1581f0a5c879cb5f7649abe9ca2ccd101e`.
Original PNG integrity:

| PNG | SHA-256 |
| --- | --- |
| `free-local-agent-alpha4-file-task.png` | `5fa406d868233899d574ccf3e33a6a5af5288ce82da1b4f42457463c399ab8e8` |
| `free-local-agent-alpha4-final-answer.png` | `fba58926dfe4e1ae26df0734d432fae03ede3ad7e0e97a707b179b7f325a52b3` |

The earlier retained-file SHA-256 was
`f6bdd21ecd9728d3da5d9d1a070dba34d204524ba6adf0dde015c44d14a884de`.
Earlier snapshots retain their own package identity:
`native-alpha4-evidence.json` records ASAR
`290228a783e9d433283544322a2a4f3bcc4bfbfa15cdbbbcb0aeb4f2158b03b4`, and
`native-alpha4r2-evidence.json` records
`7a1bee1fc47c2352111580621445a8a7fcc6580310daa30b9286645eab54854a`.
These files can also contain saved sessions from previous payloads; their capture
hash alone is not proof that every listed session ran on that payload.

</details>

## Earlier failures retained

- Validation record `7e795c28-21ee-4d4a-84e7-671557499902` failed the exact file
  sequence on a preceding payload. Its successful chat/tool probes did not
  establish agent reliability. It remains historical.
- A preceding exact-file task created its file, then repeatedly requested a
  nonexistent command log and was cancelled. It was not a completed edit/readback
  task. Final R4 registration/guards were changed afterward; this earlier failure
  is not silently counted as a final-payload pass.
- One preceding garbled native input reached a denied creation proposal. Denial
  produced no mutation and a blocked answer. That observation supports the
  recorded denial boundary, not the intended task's completion.

The separate [alpha.3 general-agent record](general-agent-validation.md) and
[WordPress acceptance](wordpress-native-acceptance.json) preserve their original
guided task results and package hashes. They are not alpha.4 project acceptance.

## Pending checks and practical limits

The earlier Mac lock prevented regular/empty-profile UI inspection on 2026-10-12.
Those R7 startup checks passed in the visible 2026-10-13 follow-up recorded above.
Final R9 regular-profile restoration, actual saved v4 migration and speed/tool
calibration passed, with the original chats, undo records and model preserved.
The preview's unsent draft remains unverified. The R9 attachment read passed with
its own visible/saved evidence, and fresh R9 Chat/reopening passed separately. R8 setup/import, Chat/reopen
and native-dialog results passed within their recorded scope; they do not
reclassify the earlier R7 task/model evidence or establish broader model quality.

An additional native empty-profile launch under the denied-public-network policy
exited **133** before a usable UI. Electron's nested GPU/network-service sandbox
initialization returned **`Operation not permitted`**, followed by GPU-service
failure. The retained log is
`.cache/general-agent-validation/alpha4r7-empty-offline-app.log`. This is a
**test-harness incompatibility / unverified offline UI check**, not a missing-model
or Gemma failure. No Electron or OS protections were disabled to bypass it.

Gemma Chat/tool/task quality remains **unverified** because loading stopped
before probes. Its completed integrity verification and measured safety stop
are the trial result, not a model-quality pass. Sustained speed, absolute
peak-memory measurements, other native preference interactions, Windows/Linux
execution, and the broader task-quality rubric retain their stated limited or
unverified scope. They are not inferred from the passed Mac contract tests.

Experimental disk remains an explicit **macOS ARM64-only** CPU trial. Its
resident/available-memory/pressure watchdog uses samples; it is not an OS memory
cap and can miss short peaks. Mapped and lazy-eligible sizes are engine-reported
quantities, distinct from resident memory. Lazy eligibility can be zero, disk
paging can be very slow, and probe success does not prove sustained usability.
There is no huge-model or frontier-quality guarantee.

Careful Agent adds bounded planning/verification/repair instructions and host
limits; it does not make a small inaccurate model reliable. Approval recovery
does not approve or replay actions. Outcome labels describe recorded operations,
not a universal task-completion certificate. Review each model's actual evidence
and remaining failures before choosing it for substantial work.
