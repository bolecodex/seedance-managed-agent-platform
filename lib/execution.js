import crypto from 'node:crypto';

const maxDetailLength = 24000;
export const eventText = content => (Array.isArray(content) ? content : []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
export const nextTimelineOrder = task => (task.timelineSequence = (task.timelineSequence || 0) + 1);
const compactText = value => String(value || '').length > maxDetailLength ? `${String(value).slice(0, maxDetailLength)}\n…（内容过长，已截断）` : String(value || '');

// Keep useful tool details without persisting inline media or multi-megabyte results.
function compact(value) {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value, (key, item) => {
    if (item?.type === 'base64') return { type: item.type, media_type: item.media_type, omitted: true };
    return typeof item === 'string' ? compactText(item) : item;
  });
  return json.length > maxDetailLength ? { preview: `${json.slice(0, maxDetailLength)}\n…（内容过长，已截断）` } : JSON.parse(json);
}

export function recordExecutionEvent(task, event, preview) {
  task.executionSteps ||= [];
  const at = event.processed_at || new Date().toISOString();
  const threadId = event.session_thread_id;
  const upsert = (id, kind, patch, finishing = false) => {
    let step = task.executionSteps.find(item => item.id === id);
    if (!step) {
      step = { id: id || crypto.randomUUID(), kind, createdAt: preview?.createdAt || at, timelineOrder: preview?.timelineOrder || nextTimelineOrder(task), ...(threadId ? { threadId } : {}) };
      task.executionSteps.push(step);
    }
    // History may contain the original call after its result has already arrived.
    const finished = Boolean(step.completedAt);
    Object.assign(step, patch, { updatedAt: at });
    if (finished && !finishing) step.status = step.isError ? 'failed' : 'completed';
    if (finishing) step.completedAt = at;
    return step;
  };
  if (event.type === 'agent.thinking') {
    upsert(event.id, 'thinking', { type: event.type, title: '思考与规划', text: compactText(eventText(event.content)), status: 'completed' }, true);
  } else if (['agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use'].includes(event.type)) {
    const status = event.evaluated_permission === 'ask' ? 'waiting' : event.evaluated_permission === 'deny' ? 'denied' : event.type === 'agent.custom_tool_use' ? 'waiting' : 'running';
    const step = upsert(event.id, 'tool', { type: event.type, name: event.name || 'tool', input: compact(event.input), permission: event.evaluated_permission, mcpServer: event.mcp_server_name, status });
    task.toolCalls ||= [];
    const call = task.toolCalls.find(item => item.id === event.id);
    if (call) Object.assign(call, step);
    else task.toolCalls.push({ ...step });
  } else if (['agent.tool_result', 'agent.mcp_tool_result', 'user.tool_result', 'user.custom_tool_result'].includes(event.type)) {
    const id = event.tool_use_id || event.mcp_tool_use_id || event.custom_tool_use_id || event.id;
    const step = upsert(id, 'tool', { status: event.is_error ? 'failed' : 'completed', isError: Boolean(event.is_error), output: compact(event.content), resultEventId: event.id }, true);
    const call = task.toolCalls?.find(item => item.id === id);
    if (call) Object.assign(call, step);
  } else if (event.type === 'user.tool_confirmation') {
    const step = task.executionSteps.find(item => item.id === event.tool_use_id);
    if (step && !step.completedAt) {
      step.status = event.result === 'deny' ? 'denied' : 'running';
      step.updatedAt = at;
      step.confirmed = event.result;
      const call = task.toolCalls?.find(item => item.id === step.id);
      if (call) Object.assign(call, step);
    }
  } else if (event.type === 'span.model_request_start') {
    upsert(event.id, 'model', { type: event.type, title: '调用模型', status: 'running' });
  } else if (event.type === 'span.model_request_end') {
    upsert(event.model_request_start_id || event.id, 'model', { type: event.type, title: '调用模型', status: event.is_error ? 'failed' : 'completed', isError: Boolean(event.is_error), usage: compact(event.model_usage) }, true);
  } else if (event.type.startsWith('session.thread_')) {
    const labels = { 'session.thread_created': '创建子线程', 'session.thread_status_running': '子线程开始执行', 'session.thread_status_idle': '子线程已空闲', 'session.thread_status_rescheduled': '子线程正在恢复', 'session.thread_status_terminated': '子线程已终止' };
    upsert(event.id, 'thread', { type: event.type, title: labels[event.type] || event.type, name: event.agent_name, status: 'completed', stopReason: event.stop_reason?.type }, true);
  } else if (['agent.thread_message_sent', 'agent.thread_message_received', 'agent.thread_context_compacted'].includes(event.type)) {
    upsert(event.id, 'activity', { type: event.type, title: event.type === 'agent.thread_context_compacted' ? '已整理上下文' : event.type === 'agent.thread_message_sent' ? '委派与协作' : '收到协作汇报', text: compactText(eventText(event.content)), status: 'completed' }, true);
  } else return false;
  return true;
}
