import type { ChatThread, ThreadMessage, ThreadToolRecord } from '../../agent/threads.ts';

const TOOL_TEXT_CHARS = 400;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function toolLine(tool: ThreadToolRecord): string {
  const args = tool.argsJson && tool.argsJson !== '{}' ? ` ${clip(tool.argsJson, TOOL_TEXT_CHARS)}` : '';
  const result = tool.outcome?.text || tool.resultPreview;
  return `  - ${tool.tool} [${tool.status}]${args}${result ? `\n    → ${clip(result, TOOL_TEXT_CHARS)}` : ''}`;
}

function messageBlock(message: ThreadMessage): string | null {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if ('kind' in message && message.kind) {
    switch (message.kind) {
      case 'activity':
        return message.tools.length ? `[도구]\n${message.tools.map(toolLine).join('\n')}` : null;
      case 'tasks':
        return `[하위 작업]\n${message.tasks.map((task) => (
          `  - ${task.title || task.role || task.taskId} [${task.status}]${task.summary ? ` ${clip(task.summary, TOOL_TEXT_CHARS)}` : ''}`
        )).join('\n')}`;
      case 'error': {
        // 알림 제목만으로는 원인을 알 수 없다. 허브가 가린 프로바이더 문구를 함께 싣는다.
        const detail = (message.failure.message || '').trim();
        const summary = text && detail && detail !== text ? `${text} — ${detail}` : text || detail;
        const code = message.failure.code ? `${message.failure.code} ` : '';
        return `[오류] ${code}${clip(summary, 1000)}`.trim();
      }
      case 'marker':
        return message.marker === 'handoff'
          ? `— ${message.from} → ${message.to} —`
          : '— 대화 압축 —';
      case 'turn':
        return message.endedAt !== null && message.outcome && message.outcome !== 'completed'
          ? `— 턴 ${message.outcome}${message.reason ? ` (${message.reason})` : ''} —`
          : null;
      case 'plan':
        return text ? `[계획]\n${text}` : '[계획]';
      case 'user-question':
        return `[질문] ${clip(text, 1000)}`;
      case 'progress':
        return text ? `[진행] ${text}` : null;
      default:
        break;
    }
  }
  if (!text) return null;
  const who = message.role === 'user' ? '사용자' : message.role === 'assistant' ? '에이전트' : '시스템';
  return `## ${who}${message.agent && message.role === 'assistant' ? ` (${message.agent})` : ''}\n${text}`;
}

/** 문제 보고에 싣는 대화 기록. 도구 인자·결과는 줄여 싣고 그림은 뺀다. */
export function formatThreadTranscript(thread: Pick<ChatThread, 'title' | 'agent' | 'model' | 'messages'>): string {
  const head = `# ${thread.title || '대화'}\n${thread.agent} · ${thread.model}`;
  const blocks = thread.messages.map(messageBlock).filter((block): block is string => Boolean(block));
  return [head, ...blocks].join('\n\n');
}
