import { request } from 'node:http';
import { actionRequestAbortedText, actionRequestDeadlines, actionRequestTimeoutText, actionResponseInterruptedText } from './action-protocol.ts';

/** Native HTTP avoids fetch's shorter implicit header timeout while a user reviews an action. */
export async function invokeLocalAction(endpoint: string, tool: string, args: object,
  signal?: AbortSignal, timeoutMs = tool === 'run_command' ? actionRequestDeadlines.command : actionRequestDeadlines.normal): Promise<any> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(endpoint)) throw new Error('Missing app-owned action endpoint.');
  if (signal?.aborted) throw new Error(actionRequestAbortedText);
  const body = JSON.stringify({ tool, args });
  return await new Promise((resolve, reject) => {
    let settled = false;
    let cancellationError: Error | undefined;
    const interrupted = (cause: Error) => cancellationError ?? new Error(actionResponseInterruptedText, { cause });
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const outgoing = request(endpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, incoming => {
      if (incoming.statusCode !== 200) {
        incoming.resume();
        finish(interrupted(new Error('The local approval host is unavailable.')));
        outgoing.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 3 * 1024 * 1024) outgoing.destroy(new Error('The local action response is too large.'));
        else chunks.push(Buffer.from(chunk));
      });
      incoming.on('error', error => finish(interrupted(error)));
      incoming.on('aborted', () => finish(interrupted(new Error('The local action response was interrupted.'))));
      incoming.on('end', () => {
        try {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid action response envelope.');
          const result = value as Record<string, unknown>;
          if (!Array.isArray(result.content) || !result.content.length || result.content.some(item =>
            !item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string') ||
            (result.isError !== undefined && typeof result.isError !== 'boolean') ||
            (result.errorCode !== undefined && typeof result.errorCode !== 'string')) throw new Error('Invalid action response content.');
          finish(undefined, result);
        }
        catch { finish(interrupted(new Error('The local action response is invalid.'))); }
      });
    });
    const abort = () => { cancellationError = new Error(actionRequestAbortedText); outgoing.destroy(cancellationError); };
    const timer = setTimeout(() => { cancellationError = new Error(actionRequestTimeoutText); outgoing.destroy(cancellationError); }, timeoutMs);
    timer.unref();
    outgoing.on('error', error => finish(interrupted(error)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else outgoing.end(body);
  });
}
