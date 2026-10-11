import type { ToolActivity } from './renderer/types.ts';

/** Working is a bounded display record; it never drives action execution. */
export const MAX_TOOL_ACTIVITIES = 256;
export const MAX_TOOL_DETAIL_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const truncatedDetail = '\n[Working details truncated at 16 KiB.]';

export interface ToolHistory {
  tools: ToolActivity[];
  truncated: boolean;
}

export const emptyToolHistory = (): ToolHistory => ({ tools: [], truncated: false });

function boundedDetail(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_TOOL_DETAIL_BYTES) return value;
  let end = MAX_TOOL_DETAIL_BYTES - encoder.encode(truncatedDetail).length;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end)) + truncatedDetail;
}

/** Updates can omit their title/input; retain the original named call. */
export function updateToolHistory(current: ToolHistory, update: ToolActivity): ToolHistory {
  const index = current.tools.findIndex(tool => tool.id === update.id);
  if (index < 0 && current.tools.length >= MAX_TOOL_ACTIVITIES) return { ...current, truncated: true };
  const previous = index < 0 ? undefined : current.tools[index];
  const input = update.input === undefined ? previous?.input : boundedDetail(update.input);
  const output = update.output === undefined ? previous?.output : boundedDetail(update.output);
  const tool: ToolActivity = {
    id: update.id,
    title: update.title && update.title !== 'Tool' ? update.title : previous?.title ?? update.title,
    status: update.status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
  return { tools: index < 0 ? [...current.tools, tool] : current.tools.map((item, position) => position === index ? tool : item), truncated: current.truncated };
}

export function restoreToolHistory(tools: ToolActivity[] = [], truncated = false): ToolHistory {
  return tools.reduce(updateToolHistory, { tools: [], truncated });
}

/** A stopped/failed turn cannot leave a historical call looking live. */
export function finishToolHistory(history: ToolHistory): ToolHistory {
  return { ...history, tools: history.tools.map(tool => ['pending', 'in_progress', 'running'].includes(tool.status)
    ? { ...tool, status: 'interrupted' } : tool) };
}
