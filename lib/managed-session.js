import crypto from 'node:crypto';

const textOf = content => (Array.isArray(content) ? content : []).filter(item => item.type === 'text').map(item => item.text || '').join('\n');
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
  signal?.addEventListener('abort', abort, { once: true });
});

// A stream is live-only. Always establish it before sending or reading history.
export function createManagedSessionClient({ baseUrl, headers, request, prepareResources, collectOutputs, project }) {
  const deliveries = new Map();
  async function applyMode(task, mode, update, signal) {
    if (mode === (task.runtimeMode || 'agent')) return;
    const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`, { signal });
    if (session.status !== 'idle') throw new Error('切换计划 / Agent 模式前，需要等待原会话回到空闲状态。');
    const agentId = session.agent?.id || task.agentId;
    if (!agentId) throw new Error('无法确认原会话 Agent，未发送新消息。');
    if ((task.runtimeMode || 'agent') === 'agent') {
      task.agentBaseline ||= { tools: session.agent?.tools, mcp_servers: session.agent?.mcp_servers || [] };
    }
    if (mode === 'agent' && !Array.isArray(task.agentBaseline?.tools)) throw new Error('缺少原会话工具配置，无法恢复 Agent 模式。');
    update({ detail: mode === 'plan' ? '正在禁用执行工具，进入计划模式。' : '正在恢复原会话工具，进入 Agent 模式。' });
    const tools = mode === 'plan' ? task.agentBaseline.tools.map(tool => ({ type: tool.type, default_config: { enabled: false, permission_policy: { type: 'always_ask' } }, ...(Array.isArray(tool.configs) && tool.configs.length ? { configs: tool.configs.map(config => ({ name: config.name, enabled: false })) } : {}) })) : task.agentBaseline.tools;
    await request(`/sessions/${encodeURIComponent(task.sessionId)}/upgrades`, { method: 'POST', body: { agent: { type: 'agent_with_upgrades', id: agentId, tools, mcp_servers: mode === 'plan' ? [] : task.agentBaseline.mcp_servers } }, signal });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const latest = await request(`/sessions/${encodeURIComponent(task.sessionId)}`, { signal });
      if (latest.status === 'idle') { update({ runtimeMode: mode }); return; }
      if (latest.status !== 'upgrading') throw new Error('会话配置升级未完成，未发送新消息。');
      await sleep(300, signal);
    }
    throw new Error('会话配置升级仍在进行，请恢复跟踪后再继续。');
  }
  async function openStream(sessionId, signal, handle) {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const connectionTimer = setTimeout(() => controller.abort(new Error('等待 Managed Agent 事件流就绪超时')), 20000);
    let response;
    try {
      response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/stream?event_deltas=agent.message`, { headers: { ...headers, Accept: 'text/event-stream' }, signal: combined });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Managed Agent 事件流不可用（HTTP ${response.status}）`);
    } catch (error) { clearTimeout(connectionTimer); throw error; }
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let isReady = false;
    const markReady = () => { isReady = true; clearTimeout(connectionTimer); readyResolve(); };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const outcome = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          if (buffer.length > 8 * 1024 * 1024) throw new Error('Managed Agent 单条事件过大');
          let separator;
          while ((separator = /\r?\n\r?\n/.exec(buffer))) {
            const packet = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            if (/^:\s*ready\b/m.test(packet)) markReady();
            const data = packet.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            event.type ||= packet.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
            // Older deployments send the initial status in place of : ready.
            if (!isReady) markReady();
            const result = handle(event);
            if (result) return { result };
          }
          if (done) throw new Error('Managed Agent 事件流中断');
        }
      } catch (error) { readyReject(error); return { error }; }
      finally { clearTimeout(connectionTimer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })();
    try { await ready; } catch (error) { controller.abort(); throw error; }
    return { outcome, close: () => controller.abort() };
  }

  async function history(sessionId, handle, signal) {
    let page;
    let pageCount = 0;
    const pages = new Set();
    do {
      if (++pageCount > 10000) throw new Error('会话历史过长，请检查分页状态');
      const query = `?${new URLSearchParams({ order: 'asc', limit: '200', ...(page ? { page } : {}) })}`;
      const result = await request(`/sessions/${encodeURIComponent(sessionId)}/events${query}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      for (const event of Array.isArray(result.data) ? result.data : []) handle(event);
      page = result.next_page;
      if (page && pages.has(page)) throw new Error('Managed Agent 历史分页游标重复');
      pages.add(page);
    } while (page);
  }

  function promptContent(task, message, selectedAssets) {
    const settings = message.options || task.options;
    const references = selectedAssets.filter(item => item.collection === 'reference' && item.arkFileId);
    const counters = { image: 0, video: 0, audio: 0 };
    const trusted = selectedAssets.filter(item => item.collection !== 'reference' && item.remoteStatus === 'Active' && item.assetId).map(item => {
      const modality = item.type.split('/')[0];
      return `${{ image: '图片', video: '视频', audio: '音频' }[modality]} ${++counters[modality]}：${item.name}；${modality}_url.url=asset://${item.assetId}；role=reference_${modality}`;
    });
    const prompt = [message.text, `创作偏好：画面比例 ${settings.aspectRatio}；风格 ${settings.style}。`, settings.optimize ? '在保留原意的前提下完善视觉细节。' : '严格遵循原始描述。', settings.versions ? '请提供多个方向并说明差异。' : '', ...(trusted.length ? [`以下为 ${project} 项目已审核可信素材，仅供支持 asset:// 的工具使用，传入对应模态 URL 字段；提示词按图片 1 / 视频 1 / 音频 1 引用，不支持时如实说明：`, ...trusted] : []), '实际产物请保存到 /mnt/session/outputs/；不要声称已生成不存在的文件。'].filter(Boolean).join('\n');
    return [{ type: 'text', text: prompt }, ...references.map(item => ({ type: item.type.startsWith('image/') ? 'image' : item.type.startsWith('video/') ? 'video' : 'document', source: { type: 'file', file_id: item.arkFileId } }))];
  }
  function messageEvents(task, message, selectedAssets) {
    const events = [{ type: 'user.message', id: message.id, content: promptContent(task, message, selectedAssets) }];
    const goal = task.goal;
    const mode = message.mode || task.mode;
    const instructions = [mode === 'plan' ? '当前为计划模式：只分析、澄清和制定可执行计划，不调用生成、编辑或其他有外部副作用的工具。' : '当前为 Agent 模式，可以使用可用工具完成用户最新需求。', goal?.status === 'active' ? `持续目标：${goal.objective}\n请持续推进，完成后报告结果与验证。遇到缺少权限、必要用户决策或无法继续时明确说明。${goal.tokenBudget ? `目标最多允许累计消耗 ${goal.tokenBudget} tokens；以服务器用量为准。` : ''}\n目标已全部实现并通过验证时，回复末尾单独写 <<GOAL_COMPLETE>>；确实需要用户输入或外部条件时写 <<GOAL_BLOCKED>>。未完成就继续推进，不要提前宣告完成。` : '当前没有需要自动推进的持续目标。之前的目标指令已暂停或结束，本轮只处理用户最新消息。'];
    events.push({ type: 'system.message', content: [{ type: 'text', text: instructions.join('\n') }] });
    return events;
  }
  function sendMessage(task, message, selectedAssets, update) {
    const key = task.sessionId;
    const operation = deliverMessage(task, message, selectedAssets, update);
    if (!deliveries.has(key)) deliveries.set(key, new Set());
    deliveries.get(key).add(operation);
    const clear = () => { deliveries.get(key)?.delete(operation); if (!deliveries.get(key)?.size) deliveries.delete(key); };
    operation.then(clear, clear);
    return operation;
  }
  async function deliverMessage(task, message, selectedAssets, update) {
    message.delivery = 'sending';
    message.goalId = task.goal?.status === 'active' ? task.goal.id : undefined;
    task.activeGoalId = message.goalId;
    update({ cloudTurnOpen: true }, { type: 'message.sending', label: '正在发送消息' });
    try {
      await request(`/sessions/${encodeURIComponent(task.sessionId)}/events`, { method: 'POST', body: { events: messageEvents(task, message, selectedAssets) } });
      message.delivery = 'sent';
      update({ detail: '消息已交给 Seedance Managed Agent。' }, { type: 'user.message', label: '消息已发送' });
    } catch (error) {
      // A streamed echo can prove acceptance before a lost HTTP response.
      if (message.delivery !== 'sent') message.delivery = error.status ? 'failed' : 'unknown';
      update({ detail: '消息提交结果需要核实；不会自动重发。' });
      throw error;
    }
  }

  async function run(task, selectedAssets, update, { message, recover = false, signal = AbortSignal.timeout(30 * 60 * 1000), reuseSession = true } = {}) {
    if (!task.sessionId || !reuseSession) {
      update({ status: 'running', detail: '正在准备 Seedance Managed Agent 与云端环境。' });
      const prepared = await prepareResources();
      if (signal.aborted) throw signal.reason;
      const mounted = selectedAssets.filter(item => item.collection === 'reference').map(item => ({ type: 'file', file_id: item.arkFileId, mount_path: `${item.id.slice(0, 8)}-${item.name.replace(/[\\/\x00-\x1f]/g, '_')}` }));
      const mode = message?.mode || task.mode || 'agent';
      let agent = prepared.agentId;
      if (mode === 'plan') {
        const baseline = await request(`/agents/${encodeURIComponent(prepared.agentId)}`, { signal });
        task.agentBaseline = { tools: baseline.tools || [], mcp_servers: baseline.mcp_servers || [] };
        const tools = (baseline.tools || []).map(tool => ({ type: tool.type, default_config: { enabled: false, permission_policy: { type: 'always_ask' } }, ...(Array.isArray(tool.configs) && tool.configs.length ? { configs: tool.configs.map(config => ({ name: config.name, enabled: false })) } : {}) }));
        agent = { type: 'agent_with_overrides', id: prepared.agentId, ...(baseline.version ? { version: baseline.version } : {}), tools, mcp_servers: [] };
      }
      // Session creation may already be accepted when pause is clicked. Finish
      // this bounded request to retain its ID, then honor pause before any send.
      const session = await request('/sessions', { method: 'POST', body: { agent, environment_id: prepared.environmentId, title: task.prompt.slice(0, 60), ...(mounted.length ? { resources: mounted } : {}) } });
      if (!session.id) throw new Error('Managed Agent 未返回 Session ID');
      update({ sessionId: session.id, agentId: prepared.agentId, runtimeMode: mode }, { type: 'session.created', label: '云端会话已创建' });
    }
    if (!recover && !task.pauseRequested && !signal.aborted) await applyMode(task, message?.mode || task.mode || 'agent', update, signal);
    if (!message && !recover) message = { id: `sevt-${crypto.randomUUID()}`, text: task.prompt, role: 'user' };
    const seen = new Set(task.seenEventIds || []);
    task.messages ||= [];
    if (message && !task.messages.some(item => item.id === message.id)) task.messages.push(message);
    const previews = new Map();
    let result;
    let acceptIdle = recover;
    let activeStream;
    const handle = event => {
      if (!event?.type) return;
      const preview = ['event_start', 'event_delta'].includes(event.type);
      if (event.id && seen.has(event.id) && !preview) return;
      if (event.id && !preview) { seen.add(event.id); task.seenEventIds = [...seen]; }
      const type = event.type;
      if (type === 'event_start' && event.event?.type === 'agent.message') previews.set(event.event.id, '');
      else if (type === 'event_delta' && previews.has(event.event_id)) {
        const text = `${previews.get(event.event_id)}${event.delta?.content?.text || ''}`.slice(-500000);
        previews.set(event.event_id, text); update({ streamingText: text, detail: 'Seedance 正在回复…' });
      } else if (type === 'agent.message') {
        previews.delete(event.id);
        const text = textOf(event.content);
        const record = { id: event.id || crypto.randomUUID(), role: 'assistant', text, goalId: task.activeGoalId, createdAt: event.processed_at || new Date().toISOString() };
        task.messages.push(record);
        update({ result: [task.result, text].filter(Boolean).join('\n\n').slice(-500000), streamingText: '', detail: '已收到回复，等待本轮结束。' }, { type, label: '收到 Agent 回复' });
      } else if (type === 'user.message') {
        const local = task.messages.find(item => item.id === event.id);
        if (local) { local.delivery = 'sent'; local.processedAt = event.processed_at; if (local.goalId) task.activeGoalId = local.goalId; update({}); }
      } else if (type === 'session.status_running') {
        result = undefined; acceptIdle = true; update({ cloudTurnOpen: true, status: task.pauseRequested ? 'pausing' : 'running', connection: 'connected', detail: 'Seedance Managed Agent 正在工作。' }, { type, label: 'Agent 运行中' });
      } else if (['agent.tool_use', 'agent.mcp_tool_use'].includes(type)) {
        task.toolCalls ||= [];
        if (!task.toolCalls.some(item => item.id === event.id)) task.toolCalls.push({ id: event.id, name: event.name || 'tool', input: event.input, status: 'running' });
        update({ detail: `正在调用工具：${event.name || 'tool'}` }, { type, label: String(event.name || '调用工具').slice(0, 80) });
      } else if (type === 'agent.tool_result') {
        const tool = task.toolCalls?.find(item => item.id === event.tool_use_id);
        if (tool) tool.status = event.is_error ? 'failed' : 'completed';
        update({ detail: event.is_error ? '工具返回错误，Agent 正在处理。' : '工具执行完成。' }, { type, label: event.is_error ? '工具返回错误' : '工具完成' });
      } else if (type === 'session.usage') update({ usage: event.usage || {}, usageRevision: (task.usageRevision || 0) + 1 });
      else if (type === 'session.status_rescheduled') update({ detail: '云端正在恢复会话，请稍候。' });
      else if (['session.deleted', 'session.status_terminated'].includes(type)) { result = { status: 'terminated', reason: type }; return result; }
      else if (type === 'session.error') {
        const retry = event.error?.retry_status?.type;
        if (['retrying', 'exhausted'].includes(retry)) update({ detail: event.error?.message || '云端正在重试。' });
        else throw Object.assign(new Error(event.error?.message || event.message || 'Managed Agent 执行失败'), { terminal: retry === 'terminal', agentError: true });
      } else if (type === 'session.status_idle' && acceptIdle) {
        const reason = event.stop_reason?.type || 'missing_stop_reason';
        update({ cloudTurnOpen: false, lastIdle: { id: event.id, reason, eventIds: event.stop_reason?.event_ids || [] } });
        result = { status: task.pauseRequested ? 'paused' : reason === 'requires_action' ? 'waiting' : reason === 'end_turn' ? 'completed' : 'interrupted', reason, eventIds: event.stop_reason?.event_ids || [] };
        return result;
      }
    };
    try {
      let reconnect = recover;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (signal.aborted) throw signal.reason;
        update({ connection: reconnect ? 'reconnecting' : 'connecting', detail: reconnect ? '正在重连原会话并补查历史，不重复生成。' : '正在连接 Agent 事件流。' });
        try {
          let catchingUp = reconnect;
          const liveBuffer = [];
          activeStream = await openStream(task.sessionId, signal, event => {
            if (catchingUp) { liveBuffer.push(event); return; }
            return handle(event);
          });
          update({ connection: 'connected' });
          if (reconnect) {
            await history(task.sessionId, handle, signal);
            catchingUp = false;
            for (const event of liveBuffer) handle(event);
            const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
            if (['terminated', 'deleted'].includes(session.status)) result = { status: 'terminated', reason: session.status };
            if (session.status === 'running' || session.status === 'rescheduling') result = undefined;
            if (!result && session.status === 'idle') {
              const queuedIds = new Set((task.pendingMessages || []).map(item => item.id));
              const unknown = task.messages.some(item => ['unknown', 'sending', 'queued'].includes(item.delivery) && !queuedIds.has(item.id));
              const idle = !task.cloudTurnOpen && task.lastIdle;
              const reason = unknown ? 'delivery_unknown' : idle?.reason || 'missing_stop_reason';
              result = { status: task.pauseRequested ? 'paused' : unknown || !idle ? 'interrupted' : reason === 'requires_action' ? 'waiting' : reason === 'end_turn' ? 'completed' : 'interrupted', reason, eventIds: idle?.eventIds || [] };
            }
          } else if (task.pauseRequested || signal.aborted) {
            result = { status: 'paused', reason: 'user_interrupt' };
          } else {
            // Persist before POST. Never retry a possibly accepted mutation.
            acceptIdle = true;
            await sendMessage(task, message, selectedAssets, update);
          }
          if (!result) {
            const outcome = await activeStream.outcome;
            if (outcome.error) throw outcome.error;
            result = outcome.result;
          }
          if (result?.status === 'completed' && deliveries.get(task.sessionId)?.size) {
            await Promise.allSettled([...deliveries.get(task.sessionId)]);
            const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`);
            if (['running', 'rescheduling'].includes(session.status)) {
              result = undefined; reconnect = true; continue;
            }
          }
          break;
        } catch (error) {
          // Legacy deployments close a completed session with a terminated error.
          // Confirm idle before reading files; never treat a live session as complete.
          if (error.agentError && error.message === 'terminated') {
            const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`);
            if (session.status === 'idle') { result = { status: task.pauseRequested ? 'paused' : 'completed', reason: 'end_turn' }; break; }
          }
          if (error.agentError || error.status || signal.aborted) throw error;
          if (!reconnect && ['sending', 'unknown'].includes(message?.delivery)) { message.delivery = 'unknown'; update({}); }
          reconnect = true; previews.clear();
          update({ streamingText: '', connection: 'reconnecting', detail: `连接中断，正在恢复原会话（${attempt + 1}/3）。` }, { type: 'session.reconnecting', label: '重连原会话' });
          if (attempt === 3) throw error;
          await sleep(500 * (attempt + 1), signal);
        } finally { activeStream?.close(); activeStream = undefined; }
      }
      update({ connection: 'connected', stopReason: result.reason, pendingApprovals: result.eventIds || [], streamingText: '', status: result.status === 'completed' ? 'running' : result.status, detail: result.status === 'paused' ? '已暂停，云端会话与已完成内容已保留。' : result.status === 'waiting' ? '工具需要你的确认后才能继续。' : result.status === 'terminated' ? '云端会话已终止，不能继续发送。' : result.status === 'interrupted' ? '本轮已中断，可以在原会话中继续。' : '本轮完成，正在整理产物。' });
      if (result.status === 'completed') await collectOutputs(task, selectedAssets, update, signal);
      return result;
    } finally { activeStream?.close(); }
  }

  return {
    run,
    sendMessage,
    interrupt: async task => {
      // An interrupt must follow an already in-flight send, otherwise the late send
      // could start a new cloud turn after we displayed 'paused'.
      await Promise.allSettled([...(deliveries.get(task.sessionId) || [])]);
      return request(`/sessions/${encodeURIComponent(task.sessionId)}/events`, { method: 'POST', body: { events: [{ type: 'user.interrupt' }] } });
    },
    confirm: (task, id, allowed) => request(`/sessions/${encodeURIComponent(task.sessionId)}/events`, { method: 'POST', body: { events: [{ type: 'user.tool_confirmation', tool_use_id: id, result: allowed ? 'allow' : 'deny', ...(!allowed ? { deny_message: '用户拒绝本次工具调用。' } : {}) }] } }),
    getSession: task => request(`/sessions/${encodeURIComponent(task.sessionId)}`)
  };
}
