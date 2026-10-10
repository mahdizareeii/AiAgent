import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const endpoint = process.env.LOCAL_AGENT_ACTION_URL;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(endpoint)) {
  throw new Error('Missing app-owned action endpoint.');
}
const server = new McpServer({ name: 'reviewed_actions', version: '0.1.0' });
const utilities = JSON.parse(process.env.LOCAL_AGENT_UTILITIES ?? '{"fileEditing":true,"terminal":true}');
const invoke = async (tool: string, args: object) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(900_000) });
  if (!response.ok) throw new Error('The local approval host is unavailable.');
  return await response.json();
};
if (utilities.fileEditing) server.registerTool('edit_file', { description: 'Propose a precise text replacement inside the selected project. The desktop asks the user to review and approve before writing.',
  inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, args => invoke('edit_file', args));
if (utilities.fileEditing) server.registerTool('write_file', { description: 'Propose writing a text file inside the selected project. The desktop shows before/after content and asks for approval.',
  inputSchema: { path: z.string(), content: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, args => invoke('write_file', args));
if (utilities.fileEditing) server.registerTool('create_files', { description: 'Create a new project scaffold with 1–20 text files in one reviewed batch. Supply files [{path,content}]. Parent folders are created automatically; existing files are never replaced. Maximum total content 512 KiB. The user reviews every file before approval; grouped undo is available.',
  inputSchema: { files: z.array(z.object({ path: z.string().max(1024), content: z.string() }).strict()).min(1).max(20) },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, args => invoke('create_files', args));
if (utilities.terminal) server.registerTool('run_command', { description: 'Propose a shell command in the project directory. Approval is required for every command. Commands run as the user and are not OS sandboxed.',
  inputSchema: { command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().int().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, args => invoke('run_command', args));
if (utilities.terminal) server.registerTool('read_command_output', { description: 'Read another bounded portion of a saved command log. Does not rerun the command.',
  inputSchema: { id: z.string().uuid(), offset: z.number().int().min(0).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, args => invoke('read_command_output', args));
void server.connect(new StdioServerTransport()).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
