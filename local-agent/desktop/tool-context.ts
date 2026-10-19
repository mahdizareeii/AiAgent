/** Only descriptions are shortened; schemas, names, defaults and enabled capabilities remain exact. */
const descriptions: Record<string, string> = {
  local_files_and_research__inspect_file: 'Hash/size a granted text/code or PDF without content. Secret and symlink guards apply.',
  local_files_and_research__read_file: 'Read exact UTF-8 including BOM, CRLF and final LF; positions are separate metadata. Copy text exactly for edits. Continue next_cursor until eof; expected_sha256 detects changes. Secrets/symlinks denied.',
  local_files_and_research__read_pdf: 'Read bounded PDF text with page labels; continue next_cursor until eof. Hash checkpoints detect changes. No OCR/encrypted PDFs.',
  local_files_and_research__list_files: 'List bounded project files; exclude secrets, dependencies/builds and symlinks. max_files<=500.',
  local_files_and_research__search_files: 'Literal project text search returns paths/lines; excludes secrets. Query<=300 chars, max_results<=100.',
  reviewed_actions__write_file: 'Create one workspace file after approval; parent folders created. Exact UTF-8 content.',
  reviewed_actions__create_files: 'Create a small batch of new workspace files after exact approval; parent folders created. Existing files are rejected. One undo group; changed=false means no changes.',
  reviewed_actions__edit_file: 'Approve an exact old_text/new_text replacement in an existing workspace file. Read/copy current text exactly, including BOM/CRLF/LF/Unicode. Correct arguments after failure; repeated identical failures stop. changed=false needs verification, not repetition.',
  reviewed_actions__run_verification: 'Preferred frozen acceptance: one command check_id from current brief; host supplies exact command/cwd. Normal approval, timeout/network/ledger checks apply; ID grants no permission. No overrides/batching. Denied/interrupted commands never replay.',
  reviewed_actions__run_command: 'Approve implementation/debug shell command/cwd/time limit. Prefer run_verification with one frozen check_id for acceptance; legacy purpose verification/checkIds work. Metadata grants no approval. Default60000ms, bounds100–600000. output_complete=true needs no log read. Interrupted commands never replay.',
  reviewed_actions__read_command_output: 'Read the exact saved run_command log UUID/returned handle; never invent an ID. Bounded offset paging. next_offset=null means all output shown; do not reread. Missing/repeated invalid logs stop; verify files instead.',
};
export function compactOwnedToolDescriptions(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools) return tools; let changed = false;
  const compacted = tools.map(tool => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
    const value = tool as Record<string, unknown>, fn = value.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return tool;
    const fields = fn as Record<string, unknown>, text = typeof fields.name === 'string' ? descriptions[fields.name] : undefined;
    if (!text || typeof fields.description !== 'string' || fields.description.length <= text.length) return tool;
    changed = true; return { ...value, function: { ...fields, description: text } };
  });
  return changed ? compacted : tools;
}

// Exact known producer text: changed or third-party documentation is never inferred
// from a tool suffix. Revisit this allowlist when host tool documentation changes.
const originalDescriptions: Record<string, string> = {
  "reviewed_actions__edit_file": "Propose one exact text replacement inside the selected project. Copy old_text exactly from read_file.text; preserve BOM, whitespace, CRLF and trailing newlines. Line/column metadata is separate, not text. Never strip or add line-number prefixes. Two identical failed edits against unchanged content stop this turn. Desktop approval is required before writing. Results report changed/unchanged and a verified SHA-256; verify with read_file rather than repeating a completed edit.",
  "reviewed_actions__write_file": "Propose writing a text file inside the selected project. The desktop shows before/after content and asks for approval.",
  "reviewed_actions__create_files": "Create a new project scaffold with 1–20 text files in one reviewed batch. Supply files [{path,content}]. Parent folders are created automatically; existing files are never replaced. Maximum total content 512 KiB. The user reviews every file before approval; grouped undo is available.",
  "reviewed_actions__run_verification": "Preferred for frozen acceptance commands: supply one command criterion check_id from the current frozen task brief. The host supplies the exact command/cwd, preserving all paths and shell quoting. Normal command approval, timeout, local network policy and verification ledger still apply; an ID grants no permission. Unknown, manual and file/preservation IDs cannot execute. Do not batch IDs or supply command/cwd overrides. Interrupted or denied commands are never automatically replayed.",
  "reviewed_actions__run_command": "Propose an implementation/debugging shell command in the project directory. Prefer run_verification with one frozen command check_id for acceptance; legacy exact command/cwd/purpose/checkIds remain supported. Approval is required for every command, including its execution time limit; verification metadata grants no permission. timeout_ms defaults to 60000; explicitly select up to 600000 for dependency setup. Result metadata gives log_id, output_complete and next_offset. When output_complete is true, use the shown output without another log read. Interrupted commands preserve partial work and are never automatically repeated. Commands run as the user and are not OS sandboxed.",
  "reviewed_actions__read_command_output": "Read additional saved command output when run_command reports output_complete=false. Copy its exact log_id (normally a short log-xxxxxxxx handle) and next_offset. Durable command-log UUIDs also work. Never invent an id or use a file/edit action id. If no saved log id was returned, do not call this tool. Use read_file to verify edited project files. Does not rerun commands.",
  "local_files_and_research__inspect_file": "Stream the SHA-256 and byte size of selected text/code or PDF before staged reading. No file content is returned. Access guards also apply to hashing.",
  "local_files_and_research__read_file": "Read exact UTF-8 source in text, including BOM, CRLF and trailing newlines. Line/column and byte positions are separate metadata, never inserted into text. Copy text exactly for edits; never add/remove line-number prefixes. Continue next_cursor until eof, including long single lines. expected_sha256 detects changed checkpoints. Secret files/symlinks are denied.",
  "local_files_and_research__read_pdf": "Read bounded PDF text with physical page and display labels. Continue next_cursor until eof; start_char locates long-page excerpts. Hash checkpoints detect changed files. Cancellable isolated extraction; no OCR or encrypted PDFs.",
  "local_files_and_research__list_files": "List bounded readable files inside a selected project, excluding credentials, dependency/build directories, and symlinks. max_files <=500.",
  "local_files_and_research__search_files": "Find a literal substring inside selected project text/code, returning file paths and line numbers. Query <=300 chars; results <=100; excludes sensitive files."
};

const fieldTitles: Record<string, Record<string, string>> = {
  local_files_and_research__inspect_file: { path: 'Path' },
  local_files_and_research__read_file: { path: 'Path', start_line: 'Start Line', max_lines: 'Max Lines', cursor: 'Cursor', expected_sha256: 'Expected Sha256', max_chars: 'Max Chars' },
  local_files_and_research__read_pdf: { path: 'Path', start_page: 'Start Page', max_pages: 'Max Pages', cursor: 'Cursor', expected_sha256: 'Expected Sha256', max_chars: 'Max Chars' },
  local_files_and_research__list_files: { path: 'Path', max_files: 'Max Files' },
  local_files_and_research__search_files: { path: 'Path', query: 'Query', max_results: 'Max Results' },
};
const fieldDescriptions: Record<string, Record<string, readonly [string, string]>> = {
  reviewed_actions__run_command: { timeout_ms: [
    'Approved execution time limit in milliseconds, 100–600000; default 60000. Longer dependency setup requires an explicit value.',
    'Approved milliseconds: default60000, bounds100–600000; longer setup needs an explicit value.',
  ] },
  reviewed_actions__read_command_output: { id: [
    'Copy the exact log_id returned by run_command: a log-xxxxxxxx handle or durable UUID. Never an edit id or invented reference.',
    'Exact run_command log_id handle or UUID; never an edit ID or invented reference.',
  ] },
};
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Exact 4K host documentation only. All schema validators and unknown metadata
 * remain byte-for-byte values; no tool, argument, default or capability changes.
 * Caller owns profile selection; this function never rewrites message content. */
export function compactPortableToolDocumentation(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools) return tools;
  let changed = false;
  const result = tools.map(tool => {
    if (!record(tool) || !record(tool.function)) return tool;
    const fn = tool.function, name = fn.name;
    if (typeof name !== 'string' || !Object.hasOwn(originalDescriptions, name)) return tool;
    // A future producer or unknown injected description must stay visible.
    if (fn.description !== originalDescriptions[name] && fn.description !== descriptions[name]) return tool;
    let next = fn;
    const set = (key: string, value: unknown) => { next = { ...next, [key]: value }; };
    if (typeof fn.description === 'string' && descriptions[name].length < fn.description.length) set('description', descriptions[name]);
    if (record(fn.parameters)) {
      const parameters = fn.parameters;
      let compact = parameters;
      const shortName = name.split('__')[1];
      if (parameters.title === `${shortName}Arguments`) {
        compact = { ...compact }; delete compact.title;
      }
      if (record(parameters.properties)) {
        let properties = parameters.properties;
        for (const [field, schema] of Object.entries(properties)) {
          if (!record(schema)) continue;
          let updated = schema;
          const title = fieldTitles[name]?.[field];
          if (title !== undefined && schema.title === title) { updated = { ...updated }; delete updated.title; }
          const description = fieldDescriptions[name]?.[field];
          if (description && schema.description === description[0]) updated = { ...updated, description: description[1] };
          if (updated !== schema) properties = { ...properties, [field]: updated };
        }
        if (properties !== parameters.properties) compact = { ...compact, properties };
      }
      if (compact !== parameters) set('parameters', compact);
    }
    if (next === fn) return tool;
    changed = true; return { ...tool, function: next };
  });
  return changed ? result : tools;
}
