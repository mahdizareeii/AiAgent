# Workspace and optional Research plugin validation

Free Local Agent **0.4.0-alpha.1**, built on macOS arm64 on 2026-10-10.

## Implemented behavior

The neutral light/dark workspace uses a compact task sidebar, centered
conversation, and bottom composer. **New task**, **Plugins**, and **Models &
hardware** are sidebar entries. The composer contains mode, folder, model, and
tool controls. Navigation to Plugins and back preserves the current task,
unsent draft, attachments, and selected folder.

Research is one bundled optional plugin. **Enable Research** loads its
task-research instructions; **Allow web research** is independent internet
permission. Both default off for new installations. Disabling the plugin omits
its instructions and registered web tools, even if web permission was previously
saved. Local reading, coding, approval, and undo do not depend on the plugin.
This release does not implement installation of arbitrary external plugins.

State version 3 preserves chats, attachments, models, paths, and utility settings.
A versionless/v1/v2 store with explicit web permission retains Research activation
when migrated. An explicit plugin preference is authoritative; a version 3 store
missing that preference defaults off. Existing read-only research chats remain
accessible. The mode chooser otherwise shows that mode only when Research is on.

Capability controls lock during a task and while settings save. Host-side checks
reject concurrent capability mutations and new requests during a save; failed
plugin/tool saves restore the previous preference and emit status. Enabling a
missing or invalid plugin asset fails before agent startup. A disabled plugin's
missing asset does not block ordinary local Agent work.

## Recorded checks

| Check | Result and scope |
| --- | --- |
| Strict TypeScript and production build | Passed |
| Full app/runtime suite | **123/123 passed**, zero skips, with public outbound networking denied and localhost allowed |
| Native backend integration cases within that suite | Source-built Goose and frozen MCP sidecar exercised through a deterministic local provider; plugin off/on, separate web consent, missing optional assets, mode restrictions, action denial, approved scaffolds, and undo passed |
| Additional temporary renderer fixture | **10/10 passed** with fake IPC, isolated profile, and no model; separate from the 123-test count |
| Renderer cases | Task/draft/attachment/folder/history roundtrips, focus, separate plugin/web consent, saved inactive web permission, failed saves, active-task locks and Stop, pending-save submission/navigation guards, named keyboard controls, and viewport overflow at 1280×900 and 820×700 |
| macOS arm64 ZIP | Built successfully; unsigned and not notarized |
| Final packaged smoke | Passed with public outbound networking denied and localhost allowed; verified native pins/manifests, packaged ASAR action bridge, denied write unchanged, bundled skill, and MCP mode/web boundaries |
| Fresh native UI inspection and screenshots | Blocked: selecting the exact new bundle path returned Computer Use server error `-10005: timeoutReached`, including after a fresh connection; no new screenshot was obtained |
| New real-model task or speed benchmark | Not run for this interface/plugin update; earlier evidence remains version-labelled |
| Windows/Linux native execution | Pending; configured packaging is not native validation |
| GitHub publication | Kept local at the user's request after push approval review. No push performed; source and package remain local |

The temporary renderer fixture exercises the production renderer through fake
desktop IPC. It does not prove main-process disk failure behavior, visible
desktop rendering, model competence, or GPU memory fit. Host persistence recovery
was reviewed in source. The packaged smoke loads no model, downloads no weights,
and calls no public web tool. Public-network denial applies to the app/runtime
and native packaged checks, not the normal isolated renderer fixture.

Research-sidecar Python code and its frozen binary were unchanged in this update.
The earlier **75 Python tests** and **7 frozen protocol checks** are historical
0.3-alpha.2 results, not fresh counts in this run. See the
[task-research record](task-research-validation.md) for the previous real Qwen4B
research-to-file task and its output-quality failures. Tool access and these
protocol tests do not establish Codex-equivalent task quality.

## Artifact

Archive: `release/workspace-update/Free Local Agent-0.4.0-alpha.1-arm64-mac.zip`

- Size: **217,037,794 bytes**
- SHA-256: `98c926b7e1a8788552af39b080494c4a80f4b122d18303631d4398a048a42a7f`
- Target: Apple Silicon, macOS 13.3 or newer

Model weights remain a separate download or local GGUF import. The older
[0.3 model-setup image](screenshots/free-local-agent-models.png) is retained as
historical partial GUI evidence. It does not show the new workspace or Plugins
page. User chats and model caches were not used in the temporary renderer tests;
the new package was launched with a separate empty validation profile.
