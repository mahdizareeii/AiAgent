import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { LocalActions, type ActionResult } from './actions.ts';

export interface ActionHost {
  url: string;
  server: Server;
  /** After aborting the turn, await this before closing the server or quitting. */
  drain: () => Promise<void>;
}

const requestSchema = z.object({
  tool: z.enum(['edit_file', 'write_file', 'run_command', 'read_command_output']),
  args: z.record(z.string(), z.unknown()),
});
const failure = (error: unknown): ActionResult => ({
  isError: true,
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
});

/** Loopback-only, unguessable per-turn MCP endpoint. Human approval stays in LocalActions. */
export async function createActionHost(actions: LocalActions, signal: AbortSignal): Promise<ActionHost> {
  if (signal.aborted) throw new Error('The action host was cancelled before startup.');
  const secret = randomBytes(32).toString('hex');
  let queue: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== `/${secret}` || request.headers.origin !== undefined || signal.aborted) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const work = (async () => {
      let reading = true;
      const onAbort = () => {
        if (reading) request.destroy(new Error('The action request was cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal.aborted) onAbort();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 3 * 1024 * 1024) throw new Error('Action request is too large.');
          chunks.push(buffer);
        }
        reading = false;
        signal.removeEventListener('abort', onAbort);
        // Decode once: network chunks can split a Persian/other UTF-8 codepoint.
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const value = requestSchema.parse(JSON.parse(body));
        // The host queue covers commands as well as edits. Only one action can
        // wait for permission at a time, even if Goose proposes parallel tools.
        const queued = queue.catch(() => undefined).then(() => actions.execute(value.tool, value.args, { signal }));
        queue = queued.then(() => undefined, () => undefined);
        const result = await queued;
        if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
      } catch (error) {
        if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(failure(error)));
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    })();
    inFlight.add(work);
    void work.then(() => inFlight.delete(work), () => inFlight.delete(work));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    if (signal.aborted) throw new Error('The action host was cancelled during startup.');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start approval host.');
    return {
      url: `http://127.0.0.1:${address.port}/${secret}`,
      server,
      drain: async () => {
        // The turn must be aborted first to prevent new accepted requests.
        // Loop because a previously accepted streaming body can join the queue.
        while (inFlight.size) await Promise.allSettled([...inFlight]);
        await queue;
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
}
