// 소켓이 끊긴 동안의 답변만 보관한다. 문서 도구는 재실행하지 않는다.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 1024;

export function retainMissedAgentText(record, event, { maxBytes = MAX_BYTES, maxEvents = MAX_EVENTS } = {}) {
  const queue = record.missedAgentText ??= { events: [], bytes: 0, overflow: null };
  const bytes = Buffer.byteLength(event.text, 'utf8');
  if (queue.overflow || queue.bytes + bytes > maxBytes || queue.events.length >= maxEvents) {
    queue.overflow ??= {
      type: 'error', agent: event.agent, turnId: event.turnId,
      message: 'Studio disconnected long enough that the answer exceeded the replay buffer. Some output could not be restored. Document edits were not retried.',
    };
    return;
  }
  const last = queue.events.at(-1);
  const sameStream = last && Object.keys(event).length === Object.keys(last).length
    && Object.keys(event).every((key) => key === 'text' || event[key] === last[key]);
  if (sameStream) last.text += event.text;
  else queue.events.push({ ...event });
  queue.bytes += bytes;
}

export function replayMissedAgentText(record, socket, sendJson) {
  const queue = record.missedAgentText;
  if (!queue) return true;
  while (queue.events.length) {
    const event = queue.events[0];
    if (!sendJson(socket, { v: 1, type: 'agent-event', event })) return false;
    queue.events.shift();
    queue.bytes -= Buffer.byteLength(event.text, 'utf8');
  }
  if (queue.overflow && !sendJson(socket, { v: 1, type: 'agent-event', event: queue.overflow })) return false;
  record.missedAgentText = null;
  return true;
}
