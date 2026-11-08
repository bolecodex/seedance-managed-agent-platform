import crypto from 'node:crypto';
import { eventText as textOf, nextTimelineOrder, recordExecutionEvent } from './execution.js';
import { generationInstructions } from './generation-policy.js';

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
  let referenceAssets;
  let generationTools;
  const referenceDefinitions = () => [...(referenceAssets ? [referenceAssets.definition, ...(referenceAssets.extraDefinitions || [])] : []), ...(generationTools?.definitions || [])];
  const withReferenceTool = tools => [...tools.filter(tool => !referenceDefinitions().some(definition => definition.name === tool.name)).map(tool => {
    if (tool.type !== 'agent_toolset_multimodal_20260825') return tool;
    const guarded = config => config.name === 'image_generate' ? { ...config, enabled: true, permission_policy: { type: 'always_ask' } } : config.name === 'video_generate' ? { ...config, enabled: false } : config;
    let configs = (tool.configs || []).map(config => generationTools ? guarded(config) : config);
    if (generationTools) for (const name of ['image_generate', 'video_generate']) if (!configs.some(config => config.name === name)) configs.push(guarded({ name }));
    if (referenceAssets) configs = [...configs.filter(config => config.name !== 'todo_write'), { name: 'todo_write', enabled: true }];
    return { ...tool, configs };
  }), ...referenceDefinitions()];
  const planTools = tools => tools.filter(tool => tool.type !== 'custom').map(tool => ({ type: tool.type, ...(tool.mcp_server_name ? { mcp_server_name: tool.mcp_server_name } : {}), default_config: { enabled: false, permission_policy: { type: 'always_ask' } }, ...(Array.isArray(tool.configs) && tool.configs.length ? { configs: tool.configs.map(config => ({ name: config.name, enabled: false })) } : {}) }));
  async function applyMode(task, mode, update, signal) {
    if (mode === (task.runtimeMode || 'agent') && (!referenceAssets || task.referenceAssetsVersion === referenceAssets.version) && (!generationTools || task.generationToolsVersion === generationTools.version)) return;
    const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`, { signal });
    if (session.status !== 'idle') throw new Error('切换计划 / Agent 模式前，需要等待原会话回到空闲状态。');
    const agentId = session.agent?.id || task.agentId;
    if (!agentId) throw new Error('无法确认原会话 Agent，未发送新消息。');
    if ((task.runtimeMode || 'agent') === 'agent') {
      task.agentBaseline ||= { tools: session.agent?.tools, mcp_servers: session.agent?.mcp_servers || [] };
    }
    if (mode === 'agent' && !Array.isArray(task.agentBaseline?.tools)) throw new Error('缺少原会话工具配置，无法恢复 Agent 模式。');
    update({ detail: mode === 'plan' ? '正在禁用执行工具，进入计划模式。' : '正在准备原会话的创作与素材入库工具。' });
    const tools = mode === 'plan' ? planTools(task.agentBaseline.tools) : withReferenceTool(task.agentBaseline.tools);
    await request(`/sessions/${encodeURIComponent(task.sessionId)}/upgrades`, { method: 'POST', body: { agent: { type: 'agent_with_upgrades', id: agentId, tools, mcp_servers: mode === 'plan' ? [] : task.agentBaseline.mcp_servers } }, signal });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const latest = await request(`/sessions/${encodeURIComponent(task.sessionId)}`, { signal });
      if (latest.status === 'idle') { update({ runtimeMode: mode, ...(referenceAssets ? { referenceAssetsVersion: referenceAssets.version } : {}), ...(generationTools ? { generationToolsVersion: generationTools.version } : {}) }); return; }
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
      response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/stream?event_deltas=agent.message,agent.thinking`, { headers: { ...headers, Accept: 'text/event-stream' }, signal: combined });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Managed Agent 事件流不可用（HTTP ${response.status}）`);
    } catch (error) {
      clearTimeout(connectionTimer);
      if (combined.aborted || error.message !== 'fetch failed') throw error;
      throw new Error(`无法连接方舟 Agent 事件流（${error.cause?.code || '网络连接失败'}）。请检查本机网络、代理和 ARK_BASE_URL 后恢复会话。`, { cause: error });
    }
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
          // SSE comments end at a newline, not an event's blank line. The live
          // service sends ": ready\n" and waits for our POST before more data.
          if (!isReady && /^:[ \t]*ready\b[^\r\n]*\r?\n/m.test(buffer)) markReady();
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
    const manifest = selectedAssets.map(item => {
      const modality = item.type.split('/')[0];
      const label = ['image', 'video', 'audio'].includes(modality) ? `${{ image: '图片', video: '视频', audio: '音频' }[modality]} ${++counters[modality]}` : '文档';
      const uri = item.remoteStatus === 'Active' && item.assetId && item.project === project ? `；${modality}_url.url=asset://${item.assetId}；role=reference_${modality}` : '';
      return `${label}：${item.name}；本机素材 ID=${item.id}${uri}`;
    });
    const prompt = [message.text, `创作偏好：画面比例 ${settings.aspectRatio}；风格 ${settings.style}。`, settings.optimize ? '在保留原意的前提下完善视觉细节。' : '严格遵循原始描述。', settings.versions ? '请提供多个方向并说明差异。' : '', ...(manifest.length ? [`以下为 ${project} 项目参考素材清单，顺序与用户引用一致。带 asset:// 的素材已审核通过，传入对应模态 URL 字段；其他人物素材先入库再生成：`, ...manifest] : []), '实际产物请保存到 /mnt/session/outputs/；不要声称已生成不存在的文件。'].filter(Boolean).join('\n');
    return [{ type: 'text', text: prompt }, ...references.map(item => ({ type: item.type.startsWith('image/') ? 'image' : item.type.startsWith('video/') ? 'video' : 'document', source: { type: 'file', file_id: item.arkFileId } }))];
  }
  function messageEvents(task, message, selectedAssets) {
    const events = [{ type: 'user.message', id: message.id, content: promptContent(task, message, selectedAssets) }];
    const goal = task.goal;
    const mode = message.mode || task.mode;
    const instructions = [mode === 'plan' ? '当前为计划模式：只分析、澄清和制定可执行计划，不调用生成、编辑或其他有外部副作用的工具。' : '当前为 Agent 模式，可以使用可用工具完成用户最新需求。', goal?.status === 'active' ? `持续目标：${goal.objective}\n请持续推进，完成后报告结果与验证。遇到缺少权限、必要用户决策或无法继续时明确说明。${goal.tokenBudget ? `目标最多允许累计消耗 ${goal.tokenBudget} tokens；以服务器用量为准。` : ''}\n目标已全部实现并通过验证时，回复末尾单独写 <<GOAL_COMPLETE>>；确实需要用户输入或外部条件时写 <<GOAL_BLOCKED>>。未完成就继续推进，不要提前宣告完成。` : '当前没有需要自动推进的持续目标。之前的目标指令已暂停或结束，本轮只处理用户最新消息。'];
    instructions.push(generationInstructions);
    if (generationTools && mode !== 'plan') instructions.push(generationTools.instructions);
    if (referenceAssets && mode !== 'plan') instructions.push(referenceAssets.instructions, `本会话已添加的人像入库候选素材（按首次引用顺序，场景素材无需入库）：\n${referenceAssets.context(task)}`);
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

  function referenceCalls(task, result) {
    if ((!referenceAssets && !generationTools) || result?.status !== 'waiting' || (task.runtimeMode || 'agent') !== 'agent') return [];
    return (task.executionSteps || []).filter(step => result.eventIds?.includes(step.id) && (step.type === 'agent.custom_tool_use' && referenceDefinitions().some(definition => definition.name === step.name) || generationTools && step.type === 'agent.tool_use' && /^(GenImage|GenVideo|image_generate|video_generate)$/i.test(step.name)));
  }
  async function prepareReferenceResults(task, calls, update, signal) {
    task.referenceAssetResults ||= {};
    for (const call of calls) {
      let saved = task.referenceAssetResults[call.id];
      if (saved && ['ready', 'sent'].includes(saved.status)) continue;
      if (saved && ['sending', 'unknown'].includes(saved.status)) throw new Error('素材入库工具的回传结果尚未确认，请恢复原会话核实；不会重复发送。');
      saved ||= task.referenceAssetResults[call.id] = { id: `sevt-${crypto.randomUUID()}`, status: 'preparing' };
      if (call.type === 'agent.tool_use') {
        saved.denyMessage = '当前要求无可见水印，内置生成工具不执行。请保留原需求改用 generate_image_without_watermark 或 generate_video_without_watermark，服务端会强制 watermark=false；需要本地参考图时先上传为本会话参考素材，或使用已生成图片的 HTTPS URL。';
        saved.status = 'ready'; update({}); continue;
      }
      for (const step of [...(task.executionSteps || []), ...(task.toolCalls || [])]) if (step.id === call.id && !step.completedAt) step.status = 'running';
      const isPortrait = call.name === referenceAssets?.definition.name;
      const tool = generationTools?.definitions.some(definition => definition.name === call.name) ? generationTools : referenceAssets;
      update({ detail: isPortrait ? '正在提交人像素材库，审核通过后继续生成。' : '正在生成无水印图片或视频。' }, { type: 'assets.preparing', label: isPortrait ? '人物参考素材入库' : '生成图片或视频' });
      try {
        const value = await tool.execute(task, call.input, detail => update({ detail }), signal, call);
        saved.content = [{ type: 'text', text: JSON.stringify(value) }];
        saved.isError = false;
      } catch (failure) {
        if (signal.aborted) throw failure;
        saved.content = [{ type: 'text', text: tool.safeError(failure) }];
        saved.isError = true;
      }
      saved.status = 'ready'; update({});
    }
  }
  async function sendReferenceResults(task, calls, update, signal) {
    for (const call of calls) {
      const saved = task.referenceAssetResults[call.id];
      if (saved.status === 'sent') continue;
      if (saved.status !== 'ready') throw Object.assign(new Error('工具结果的提交状态尚未核实，请恢复原会话查询，不会重复发送。'), { status: 409 });
      signal.throwIfAborted();
      saved.status = 'sending'; update({ cloudTurnOpen: true });
      try {
        const event = saved.denyMessage ? { type: 'user.tool_confirmation', id: saved.id, tool_use_id: call.id, result: 'deny', deny_message: saved.denyMessage } : { type: 'user.custom_tool_result', id: saved.id, custom_tool_use_id: call.id, content: saved.content, is_error: saved.isError };
        await request(`/sessions/${encodeURIComponent(task.sessionId)}/events`, { method: 'POST', body: { events: [event] } });
        saved.status = 'sent'; update({ pendingApprovals: (task.pendingApprovals || []).filter(id => id !== call.id), detail: saved.isError ? '已回传工具错误，Agent 正在处理。' : '已回传工具结果，Agent 继续创作。' }, { type: 'assets.ready', label: saved.isError ? '已回传工具问题' : '工具执行完成，继续创作' });
      } catch (failure) {
        if (saved.status !== 'sent') saved.status = failure.status ? 'ready' : 'unknown';
        update({}); throw failure;
      }
    }
  }

  async function run(task, selectedAssets, update, { message, recover = false, signal = AbortSignal.timeout(30 * 60 * 1000), reuseSession = true } = {}) {
    if (!task.sessionId || !reuseSession) {
      update({ status: 'running', detail: '正在准备 Seedance Managed Agent 与云端环境。' }, { type: 'task.preparing', label: '准备 Agent 与环境' });
      const prepared = await prepareResources();
      if (signal.aborted) throw signal.reason;
      const mounted = selectedAssets.filter(item => item.collection === 'reference').map(item => ({ type: 'file', file_id: item.arkFileId, mount_path: `${item.id.slice(0, 8)}-${item.name.replace(/[\\/\x00-\x1f]/g, '_')}` }));
      const mode = message?.mode || task.mode || 'agent';
      let agent = prepared.agentId;
      if (mode === 'plan' || referenceAssets || generationTools) {
        const baseline = await request(`/agents/${encodeURIComponent(prepared.agentId)}`, { signal });
        task.agentBaseline = { tools: baseline.tools || [], mcp_servers: baseline.mcp_servers || [] };
        const tools = mode === 'plan' ? planTools(baseline.tools || []) : withReferenceTool(baseline.tools || []);
        agent = { type: 'agent_with_overrides', id: prepared.agentId, ...(baseline.version ? { version: baseline.version } : {}), tools, ...(mode === 'plan' ? { mcp_servers: [] } : {}) };
      }
      // Session creation may already be accepted when pause is clicked. Finish
      // this bounded request to retain its ID, then honor pause before any send.
      const session = await request('/sessions', { method: 'POST', body: { agent, environment_id: prepared.environmentId, title: task.prompt.slice(0, 60), ...(mounted.length ? { resources: mounted } : {}) } });
      if (!session.id) throw new Error('Managed Agent 未返回 Session ID');
      update({ sessionId: session.id, agentId: prepared.agentId, runtimeMode: mode, ...(referenceAssets ? { referenceAssetsVersion: referenceAssets.version } : {}), ...(generationTools ? { generationToolsVersion: generationTools.version } : {}) }, { type: 'session.created', label: '云端会话已创建' });
    }
    if (!recover && !task.pauseRequested && !signal.aborted) await applyMode(task, message?.mode || task.mode || 'agent', update, signal);
    if (!message && !recover) message = { id: `sevt-${crypto.randomUUID()}`, text: task.prompt, role: 'user' };
    const seen = new Set(task.seenEventIds || []);
    task.messages ||= [];
    if (message && !task.messages.some(item => item.id === message.id)) task.messages.push(message);
    const previews = new Map();
    const publishPreviews = () => ({ streamingPreviews: [...previews.values()].map(({ blocks, ...item }) => item), streamingText: [...previews.values()].filter(item => item.type === 'agent.message').map(item => item.text).join('\n\n') });
    let result;
    let acceptIdle = recover;
    let activeStream;
    let pendingReferenceCalls = [];
    let pendingAssetRecovery;
    const handle = event => {
      if (!event?.type) return;
      const preview = ['event_start', 'event_delta'].includes(event.type);
      // A queued echo (processed_at=null) can later arrive as the processed event.
      if (event.id && seen.has(event.id) && !preview) return;
      if (event.id && !preview && event.processed_at !== null) { seen.add(event.id); task.seenEventIds = [...seen]; }
      const type = event.type;
      if (type === 'user.custom_tool_result' && task.referenceAssetResults?.[event.custom_tool_use_id]) {
        task.referenceAssetResults[event.custom_tool_use_id].status = 'sent';
      }
      if (type === 'user.tool_confirmation' && task.referenceAssetResults?.[event.tool_use_id]?.denyMessage) {
        task.referenceAssetResults[event.tool_use_id].status = 'sent';
      }
      if (type === 'event_start' && ['agent.message', 'agent.thinking'].includes(event.event?.type)) {
        if (!seen.has(event.event.id)) {
          previews.set(event.event.id, { id: event.event.id, type: event.event.type, text: '', blocks: new Map(), createdAt: event.processed_at || new Date().toISOString(), timelineOrder: nextTimelineOrder(task) });
          update({ ...publishPreviews(), detail: event.event.type === 'agent.thinking' ? 'Seedance 正在思考与规划…' : 'Seedance 正在回复…' });
        }
      }
      else if (type === 'event_delta' && previews.has(event.event_id)) {
        const item = previews.get(event.event_id);
        const index = event.delta?.index || 0;
        item.blocks.set(index, `${item.blocks.get(index) || ''}${event.delta?.content?.text || ''}`.slice(-500000));
        item.text = [...item.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n').slice(-500000);
        update({ ...publishPreviews(), detail: item.type === 'agent.thinking' ? 'Seedance 正在思考与规划…' : 'Seedance 正在回复…' });
      } else if (type === 'agent.message') {
        const draft = previews.get(event.id);
        previews.delete(event.id);
        const text = textOf(event.content);
        const record = { id: event.id || crypto.randomUUID(), role: 'assistant', text, goalId: task.activeGoalId, createdAt: event.processed_at || new Date().toISOString(), timelineOrder: draft?.timelineOrder || nextTimelineOrder(task) };
        task.messages.push(record);
        update({ result: [task.result, text].filter(Boolean).join('\n\n').slice(-500000), ...publishPreviews(), detail: '已收到回复，等待本轮结束。' }, { id: event.id, type, label: '收到 Agent 回复', at: event.processed_at });
      } else if (type === 'user.message') {
        const local = task.messages.find(item => item.id === event.id);
        if (local) { local.delivery = 'sent'; local.processedAt = event.processed_at; if (local.goalId) task.activeGoalId = local.goalId; update({}); }
      } else if (type === 'session.status_running') {
        result = undefined; acceptIdle = true; update({ cloudTurnOpen: true, status: task.pauseRequested ? 'pausing' : 'running', connection: 'connected', detail: 'Seedance Managed Agent 正在工作。' }, { type, label: 'Agent 运行中' });
      } else if (recordExecutionEvent(task, event, previews.get(event.id))) {
        previews.delete(event.id);
        if (referenceAssets && type.endsWith('tool_result')) {
          const tool = task.executionSteps.find(step => step.resultEventId === event.id);
          if (/InputImageSensitiveContentDetected\.PrivacyInformation/.test(textOf(event.content))) task.referencePrivacyFailure = { eventId: event.id, messageId: task.currentMessageId };
          else if (!event.is_error && /^(GenVideo|video_generate)$/i.test(tool?.name || '')) delete task.referencePrivacyFailure;
        }
        const detail = type === 'agent.thinking' ? '已收到思考与规划，Agent 正在继续。' : type.endsWith('tool_use') ? `${event.evaluated_permission === 'ask' ? '等待确认工具' : event.evaluated_permission === 'deny' ? '工具调用已拒绝' : '正在调用工具'}：${event.name || 'tool'}` : type.endsWith('tool_result') ? event.is_error ? '工具返回错误，Agent 正在处理。' : '工具执行完成。' : task.detail;
        update({ ...publishPreviews(), detail });
      } else if (type === 'session.usage') update({ usage: event.usage || {}, usageRevision: (task.usageRevision || 0) + 1 });
      else if (type === 'session.status_rescheduled') update({ detail: '云端正在恢复会话，请稍候。' }, { id: event.id, type, label: '云端正在恢复', at: event.processed_at });
      else if (['session.deleted', 'session.status_terminated'].includes(type)) { update({}, { id: event.id, type, label: type === 'session.deleted' ? '云端会话已删除' : '云端会话已终止', at: event.processed_at }); result = { status: 'terminated', reason: type }; return result; }
      else if (type === 'session.error') {
        const retry = event.error?.retry_status?.type;
        if (['retrying', 'exhausted'].includes(retry)) update({ detail: event.error?.message || '云端正在重试。' }, { id: event.id, type, label: retry === 'retrying' ? '云端正在重试' : '云端重试已耗尽', at: event.processed_at });
        else throw Object.assign(new Error(event.error?.message || event.message || 'Managed Agent 执行失败'), { terminal: retry === 'terminal', agentError: true });
      } else if (type === 'session.status_idle' && acceptIdle) {
        const reason = event.stop_reason?.type || 'missing_stop_reason';
        if (reason === 'requires_action') for (const step of [...(task.executionSteps || []), ...(task.toolCalls || [])]) if (event.stop_reason?.event_ids?.includes(step.id) && !step.completedAt) step.status = 'waiting';
        update({ cloudTurnOpen: false, lastIdle: { id: event.id, reason, eventIds: event.stop_reason?.event_ids || [] } }, { id: event.id, type, label: task.pauseRequested ? '云端已暂停' : reason === 'end_turn' ? '本轮执行结束' : reason === 'requires_action' ? '等待工具确认' : '本轮执行中断', at: event.processed_at });
        result = { status: task.pauseRequested ? 'paused' : reason === 'requires_action' ? 'waiting' : reason === 'end_turn' ? 'completed' : 'interrupted', reason, eventIds: event.stop_reason?.event_ids || [] };
        return result;
      }
    };
    try {
      let reconnect = recover;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (signal.aborted) throw signal.reason;
        update({ connection: reconnect ? 'reconnecting' : 'connecting', detail: reconnect ? '正在重连原会话并补查历史，不重复生成。' : '正在连接 Agent 事件流。' }, { type: 'session.connecting', label: reconnect ? '连接原会话事件流' : '连接 Agent 事件流' });
        try {
          let catchingUp = reconnect;
          const liveBuffer = [];
          activeStream = await openStream(task.sessionId, signal, event => {
            if (catchingUp) { liveBuffer.push(event); return; }
            return handle(event);
          });
          update({ connection: 'connected', detail: reconnect ? '事件流已连接，正在补查历史。' : '事件流已就绪，正在发送消息。' }, { type: 'session.connected', label: '事件流已连接' });
          if (reconnect) {
            await history(task.sessionId, handle, signal);
            catchingUp = false;
            for (const event of liveBuffer) handle(event);
            update({}, { type: 'session.history_synced', label: '已同步会话历史' });
            const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
            if (['terminated', 'deleted'].includes(session.status)) result = { status: 'terminated', reason: session.status };
            if (session.status === 'running' || session.status === 'rescheduling') result = undefined;
            if (!result && session.status === 'idle') {
              const queuedIds = new Set((task.pendingMessages || []).map(item => item.id));
              const unknown = task.messages.some(item => ['unknown', 'sending'].includes(item.delivery) && !queuedIds.has(item.id));
              const unsent = task.messages.some(item => item.delivery === 'queued' && !queuedIds.has(item.id));
              const idle = !task.cloudTurnOpen && task.lastIdle;
              const reason = unknown ? 'delivery_unknown' : unsent ? 'message_not_sent' : idle?.reason || 'missing_stop_reason';
              result = { status: task.pauseRequested ? 'paused' : unknown || unsent || !idle ? 'interrupted' : reason === 'requires_action' ? 'waiting' : reason === 'end_turn' ? 'completed' : 'interrupted', reason, eventIds: idle?.eventIds || [] };
            }
            if (!task.pauseRequested && session.status === 'idle') {
              const pending = Object.entries(task.referenceAssetResults || {}).filter(([, saved]) => saved.status !== 'sent').map(([id]) => id);
              if (pending.length) result = { status: 'waiting', reason: 'requires_action', eventIds: pending };
            }
            update({ recoveryPending: false, ...(!result ? { status: task.pauseRequested ? 'pausing' : 'running' } : {}) });
          } else if (task.pauseRequested || signal.aborted) {
            result = { status: 'paused', reason: 'user_interrupt' };
          } else {
            // Persist before POST. Never retry a possibly accepted mutation.
            acceptIdle = true;
            await sendMessage(task, message, selectedAssets, update);
          }
          if (pendingReferenceCalls.length) {
            // The previous stream ended at requires_action. This fresh stream
            // must be ready before results resume the cloud Agent.
            const unsent = pendingReferenceCalls.filter(call => task.referenceAssetResults[call.id]?.status !== 'sent');
            if (unsent.length) {
              result = undefined; acceptIdle = true;
              await sendReferenceResults(task, unsent, update, signal);
            }
            pendingReferenceCalls = [];
          }
          if (pendingAssetRecovery) {
            result = undefined; acceptIdle = true; message = pendingAssetRecovery;
            await sendMessage(task, pendingAssetRecovery, [], update);
            pendingAssetRecovery = undefined;
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
          const calls = referenceCalls(task, result);
          if (calls.length) {
            await prepareReferenceResults(task, calls, update, signal);
            pendingReferenceCalls = calls; result = undefined; reconnect = true;
            // A successful business-tool round is not a network retry.
            attempt = -1; continue;
          }
          const privacy = task.referencePrivacyFailure;
          if (referenceAssets && result?.status === 'completed' && !task.pauseRequested && privacy && privacy.messageId === task.currentMessageId && task.referencePrivacyRecoveryFor !== privacy.messageId) {
            const ids = [...new Set(task.messages.filter(item => item.role === 'user' && item.delivery === 'sent').flatMap(item => item.assetIds || []))];
            if (ids.length) {
              task.referencePrivacyRecoveryFor = privacy.messageId;
              pendingAssetRecovery = { id: `sevt-${crypto.randomUUID()}`, role: 'user', source: 'asset-recovery', delivery: 'queued', assetIds: [], text: '自动继续：刚才的视频工具返回人像隐私校验错误。立即按私域人像素材库工作流调用 prepare_portrait_assets，将被拦截的原始人像参考素材统一提交当前项目的 AIGC 库，真人与虚拟角色均按此流程处理，无需先做 H5 本人认证。等待平台审核 Active，再调用 generate_video_with_assets 沿用原需求生成。不要更改素材来源标记，保留原图人物、场景、时长与分镜；审核未通过时如实说明平台原因。', createdAt: new Date().toISOString(), timelineOrder: nextTimelineOrder(task) };
              task.messages.push(pendingAssetRecovery);
              update({ detail: '检测到人像参考需入库，正在自动继续处理。' }, { type: 'assets.recovery', label: '人像素材自动入库续跑' });
              result = undefined; reconnect = true; attempt = -1; continue;
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
          update({ streamingText: '', streamingPreviews: [], connection: 'reconnecting', detail: `连接中断，正在恢复原会话（${attempt + 1}/3）。` }, { type: 'session.reconnecting', label: '重连原会话' });
          if (attempt === 3) throw error;
          await sleep(500 * (attempt + 1), signal);
        } finally { activeStream?.close(); activeStream = undefined; }
      }
      update({ connection: 'connected', stopReason: result.reason, pendingApprovals: result.eventIds || [], streamingText: '', streamingPreviews: [], status: result.status === 'completed' ? 'running' : result.status, detail: result.status === 'paused' ? '已暂停，云端会话与已完成内容已保留。' : result.status === 'waiting' ? '工具需要你的确认后才能继续。' : result.status === 'terminated' ? '云端会话已终止，不能继续发送。' : result.reason === 'message_not_sent' ? '原消息尚未发送，已保存在本机。点击「继续执行」后提交原消息。' : result.status === 'interrupted' ? '本轮已中断，可以在原会话中继续。' : '本轮完成，正在整理产物。' });
      if (result.status === 'completed') await collectOutputs(task, selectedAssets, update, signal);
      return result;
    } finally { activeStream?.close(); }
  }

  return {
    configureReferenceAssets: tool => { referenceAssets = tool; },
    configureGenerationTools: tools => { generationTools = tools; },
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
