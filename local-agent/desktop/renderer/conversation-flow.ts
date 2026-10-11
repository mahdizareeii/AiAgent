import type { ChatMessage, StageProgress, ToolActivity } from './types';

export function isNearConversationEnd({ scrollHeight, scrollTop, clientHeight }: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = 96) {
  return scrollHeight - Math.max(0, scrollTop) - clientHeight <= threshold;
}

export function shouldFollowConversation(following: boolean, expandedActivity: number) {
  return following && expandedActivity === 0;
}

/** A fallback row occupies the same index as its eventual assistant message. */
export function workingDetailsIndexes(messages: ChatMessage[], active: boolean, hasTools: boolean) {
  const visible = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && (message.thinking || message.tools?.length || message.toolsTruncated || (index === messages.length - 1 && (active || hasTools)))) visible.add(index);
  });
  if (messages.at(-1)?.role !== 'assistant' && (active || hasTools)) visible.add(messages.length);
  return visible;
}

export function workingStatus({ thinkingActive, waitingApproval, stage, tools = [] }: { thinkingActive?: boolean; waitingApproval?: boolean; stage?: StageProgress | null; tools?: ToolActivity[] }) {
  if (waitingApproval) return 'Waiting for your approval';
  if (thinkingActive) return 'Thinking locally';
  const running = tools.findLast((tool) => ['pending', 'in_progress', 'running'].includes(tool.status));
  if (running) return `${running.status === 'pending' ? 'Preparing' : 'Running'} ${running.title}`;
  return stage?.message || stage?.stage.replace(/[_-]/g, ' ') || 'Working locally';
}
