import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { invokeLocalAction } from './action-client.ts';
import { commandTimeoutLimits } from './action-protocol.ts';

const endpoint = process.env.LOCAL_AGENT_ACTION_URL;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(endpoint)) {
  throw new Error('Missing app-owned action endpoint.');
}
const server = new McpServer({ name: 'reviewed_actions', version: '0.1.0' });
const utilities = JSON.parse(process.env.LOCAL_AGENT_UTILITIES ?? '{"fileEditing":true,"terminal":true}');
const bridgeController = new AbortController();
const invoke = (tool: string, args: object, signal: AbortSignal) =>
  invokeLocalAction(endpoint, tool, args, AbortSignal.any([signal, bridgeController.signal]));
// The SDK's stdio transport does not close itself on EOF. Cancel pending local
// requests when its parent disappears, including an approval still being read.
process.stdin.once('end', () => { bridgeController.abort(); void server.close(); });
if (utilities.fileEditing) server.registerTool('edit_file', { description: 'Propose one exact text replacement inside the selected project. Copy old_text exactly from read_file.text; preserve BOM, whitespace, CRLF and trailing newlines. Line/column metadata is separate, not text. Never strip or add line-number prefixes. Two identical failed edits against unchanged content stop this turn. Desktop approval is required before writing. Results report changed/unchanged and a verified SHA-256; verify with read_file rather than repeating a completed edit.',
  inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, (args, extra) => invoke('edit_file', args, extra.signal));
if (utilities.fileEditing) server.registerTool('write_file', { description: 'Propose writing a text file inside the selected project. The desktop shows before/after content and asks for approval.',
  inputSchema: { path: z.string(), content: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, (args, extra) => invoke('write_file', args, extra.signal));
if (utilities.fileEditing) server.registerTool('create_files', { description: 'Create a new project scaffold with 1–20 text files in one reviewed batch. Supply files [{path,content}]. Parent folders are created automatically; existing files are never replaced. Maximum total content 512 KiB. The user reviews every file before approval; grouped undo is available.',
  inputSchema: { files: z.array(z.object({ path: z.string().max(1024), content: z.string() }).strict()).min(1).max(20) },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, (args, extra) => invoke('create_files', args, extra.signal));
if (utilities.terminal) server.registerTool('run_command', { description: 'Propose a shell command in the project directory. Approval is required for every command, including its execution time limit. timeout_ms defaults to 60000; explicitly select up to 600000 for dependency setup. Result metadata gives log_id, output_complete and next_offset. When output_complete is true, use the shown output without another log read. Interrupted commands preserve partial work and are never automatically repeated. Commands run as the user and are not OS sandboxed.',
  inputSchema: { command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().int().min(commandTimeoutLimits.minimum).max(commandTimeoutLimits.maximum).default(commandTimeoutLimits.default)
    .describe('Approved execution time limit in milliseconds, 100–600000; default 60000. Longer dependency setup requires an explicit value.') },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, (args, extra) => invoke('run_command', args, extra.signal));
if (utilities.terminal) server.registerTool('read_command_output', { description: 'Read additional saved command output when run_command reports output_complete=false. Copy its exact log_id (normally a short log-xxxxxxxx handle) and next_offset. Durable command-log UUIDs also work. Never invent an id or use a file/edit action id. If no saved log id was returned, do not call this tool. Use read_file to verify edited project files. Does not rerun commands.',
  inputSchema: { id: z.union([z.string().regex(/^log-[a-f0-9]{8}$/), z.string().uuid()]).describe('Copy the exact log_id returned by run_command: a log-xxxxxxxx handle or durable UUID. Never an edit id or invented reference.'), offset: z.number().int().min(0).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (args, extra) => invoke('read_command_output', args, extra.signal));
void server.connect(new StdioServerTransport()).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
