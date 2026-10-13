import type { Mode } from './renderer/types.ts';

export function newSessionTitle(mode: Mode): string {
  return mode === 'coding' ? 'New task' : mode === 'research' ? 'New research' : 'New chat';
}

export function titleFromFirstRequest(current: string, request: string): string {
  if (!['New chat', 'New task', 'New research'].includes(current)) return current;
  return request.trim().slice(0, 60) || current;
}
