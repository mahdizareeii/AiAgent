import type { ChatMessage, Mode, StageProgress, ToolActivity } from './types';

/** Execution policy belongs in Advanced; this area presents actual progress. */
export function conversationStage(stage: StageProgress | null): StageProgress | null {
  if (!stage) return null;
  if (stage.stage === 'Plan → Implement → Verify → Repair → Final' || stage.message === 'Results are checked against tool evidence; approvals pause the execution clock.') return null;
  return stage;
}

export function composerPlaceholder(mode: Mode, ready: boolean, busy: boolean, opening: boolean) {
  if (busy) return mode === 'assistant' ? 'Replying locally…' : 'Working on your task…';
  if (opening) return 'Opening the conversation…';
  if (!ready) return mode === 'assistant' ? 'Write a message, then choose a local model…' : 'Write a task, then choose a local model…';
  return mode === 'coding' ? 'Describe a task, ask about your project, or add files…' : 'Ask a question or add files…';
}

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
