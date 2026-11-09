import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { nextTimelineOrder } from './execution.js';
import { prepareOutputFiles } from './output-files.js';

export const busyStatus = status => ['queued', 'running', 'pausing', 'recovering'].includes(status);
const error = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const newId = () => `sevt-${crypto.randomUUID()}`;
const tokens = usage => ['input_tokens', 'output_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (Number(usage?.[key]) || 0), 0) + Object.values(usage?.cache_creation || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);

export function createConversations({ tasks, ark, taskQueue, update, persist, getAssets, validateOptions, redact, demoResult }) {
  const jobs = new Map();
  const locks = new Set();
  const confirming = new Set();
  function assertConnection(task) {
    if (!task.demo && task.connectionScope && task.connectionScope !== ark.config.connectionScope) throw error(409, '此会话属于其他项目或 API 地址，请在连接设置中恢复原连接后继续，或新建会话。');
    if (!task.demo && !ark.config.filesApiConfigured) throw error(409, '请先在连接设置中配置 API Key，再继续此会话。');
  }
  const resolveAssets = ids => {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw error(400, '最多引用 20 份不重复的参考素材');
    const selected = ids.map(id => getAssets().find(item => item.id === id));
    if (selected.some(item => !item || (item.collection !== 'reference' && !(item.assetId && item.remoteStatus === 'Active' && item.project === ark.config.project)))) throw error(400, '只能引用参考素材或当前项目审核通过的可信资产');
    if (ark.config.configured && selected.some(item => item.collection === 'reference' && (!item.arkFileId || item.error))) throw error(400, '参考素材尚未同步到 Files API');
    return selected.map(item => ({ ...item }));
  };
  const message = (text, assetIds = [], source = 'user') => ({ id: newId(), role: 'user', text, assetIds, source, delivery: 'queued', createdAt: now() });
  function prepare(task) {
    if (!task.messages) {
      const original = message(task.prompt, task.assetIds || []);
      if (task.status !== 'queued') original.delivery = 'sent';
      task.messages = [original];
      if (task.result) task.messages.push({ id: newId(), role: 'assistant', text: task.result, createdAt: task.updatedAt || task.createdAt });
    }
    task.pendingMessages ||= [];
    // JSON persistence loses object identity. Queue and timeline must point at
    // the same message so delivery updates survive the next restart as well.
    const byId = new Map(task.messages.map(item => [item.id, item]));
    task.pendingMessages = task.pendingMessages.map(item => {
      if (!byId.has(item.id)) { task.messages.push(item); byId.set(item.id, item); }
      return byId.get(item.id);
    });
    task.events ||= [];
    task.executionSteps ||= [];
    // Older conversations predate ordered execution records.
    for (const item of [...task.messages, ...task.executionSteps].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
      if (!item.timelineOrder) item.timelineOrder = nextTimelineOrder(task);
    }
    task.result ||= '';
    const referenceIds = new Set([...(task.assetIds || []), ...task.messages.filter(item => item.role === 'user' && ['sending', 'sent'].includes(item.delivery)).flatMap(item => item.assetIds || [])]);
    task.files = prepareOutputFiles(task, task.files, getAssets().filter(item => referenceIds.has(item.id)));
    task.mode ||= 'agent';
    task.revision ||= 0;
    return task;
  }
  function find(id) {
    const task = tasks.find(item => item.id === id);
    if (!task) throw error(404, '会话不存在');
    return prepare(task);
  }
  function validateText(text) {
    if (typeof text !== 'string' || !text.trim()) throw error(400, '请输入消息内容');
    return text.trim();
  }
  function validateRequestId(id) {
    if (id !== undefined && (typeof id !== 'string' || !/^[\w-]{8,128}$/.test(id))) throw error(400, '请求标识格式不正确');
    return id;
  }
  function newGoal(task, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, '目标格式错误');
    const objective = validateText(value.objective);
    if (value.tokenBudget !== undefined && value.tokenBudget !== null && (!Number.isSafeInteger(value.tokenBudget) || value.tokenBudget < 1 || value.tokenBudget > 10000000)) throw error(400, 'Token 预算须为 1–10000000 的整数');
    return { id: crypto.randomUUID(), objective, status: 'active', tokenBudget: value.tokenBudget || null, tokensUsed: 0, startTokens: tokens(task.usage), startUsageRevision: task.usageRevision || 0, turns: 0, createdAt: now(), updatedAt: now() };
  }
  function summary(task) {
    const { result, files, events, messages, seenEventIds, toolCalls, executionSteps, streamingPreviews, streamingText, ...rest } = task;
    return { ...rest, messageCount: messages?.length || 0, pendingCount: task.pendingMessages?.length || 0 };
  }
  function goalPatch(task) {
    const goal = task.goal;
    if (!goal || goal.status !== 'active') return;
    const lastAnswer = task.messages.filter(item => item.role === 'assistant' && item.goalId === goal.id).at(-1);
    const turnId = task.lastIdle?.id;
    if (!lastAnswer || goal.lastTurnId === turnId && turnId) return;
    const output = lastAnswer.text.trim().split(/\r?\n/).at(-1);
    const used = Math.max(0, tokens(task.usage) - (goal.startTokens || 0));
    goal.tokensUsed = used;
    goal.turns = (goal.turns || 0) + 1;
    goal.lastTurnId = turnId;
    if (output === '<<GOAL_COMPLETE>>') goal.status = 'complete';
    else if (output === '<<GOAL_BLOCKED>>') goal.status = 'blocked';
    else if (goal.tokenBudget && (!task.usage || (task.usageRevision || 0) <= (goal.lastUsageRevision ?? goal.startUsageRevision ?? 0))) { goal.status = 'blocked'; goal.blockReason = '未收到云端用量，无法继续核算 Token 预算，请核实后继续。'; }
    else if (goal.tokenBudget && used >= goal.tokenBudget) goal.status = 'budget_exceeded';
    if (task.demo) goal.status = 'blocked';
    goal.lastUsageRevision = task.usageRevision || 0;
    goal.updatedAt = now();
    update(task, {}, { type: `goal.${goal.status}`, label: `目标${{ active: '继续推进', complete: '已完成', blocked: '需要检查', budget_exceeded: '达到预算' }[goal.status]}` });
    return goal.status === 'active';
  }
  async function execute(task, input, assets, recover, controller) {
    const emit = (patch, event) => { if (jobs.get(task.id)?.controller === controller) update(task, patch, event); };
    try {
      if (controller.signal.aborted || task.status === 'paused') return;
      emit({ status: recover ? 'recovering' : 'running', error: undefined, connection: 'connecting' });
      if (task.demo) {
        input ||= task.messages.find(item => item.delivery === 'queued');
        if (input) input.delivery = 'sent';
        emit({ detail: '正在运行本机交互演示，不调用模型。' }, { type: 'demo.start', label: '本机演示 · 无模型调用' });
        await sleep(500, undefined, { signal: controller.signal });
        emit({ detail: '已整理创作参数，正在生成演示文本。' }, { type: 'demo.layout', label: '创作参数已整理' });
        await sleep(500, undefined, { signal: controller.signal });
        const result = demoResult({ ...task, prompt: input?.text || task.prompt }, assets);
        task.messages.push({ id: newId(), role: 'assistant', text: result, goalId: task.goal?.id, createdAt: now(), timelineOrder: nextTimelineOrder(task) });
        emit({ status: 'completed', result: [task.result, result].filter(Boolean).join('\n\n'), connection: 'connected', detail: '演示完成 · 未调用模型。' }, { type: 'demo.completed', label: '演示方案已就绪' });
      } else {
        const deadline = AbortSignal.timeout(30 * 60 * 1000);
        await ark.managed.run(task, assets, emit, { message: input, recover, signal: AbortSignal.any([controller.signal, deadline]) });
      }
      if (task.status === 'completed' && !task.pauseRequested) goalPatch(task);
    } catch (cause) {
      if (task.pauseRequested && controller.signal.aborted) emit({ status: 'paused', detail: '已暂停，会话上下文已保留。' });
      else emit({ status: cause.terminal ? 'terminated' : task.sessionId && !cause.agentError ? 'interrupted' : 'failed', error: redact(cause.message), connection: 'disconnected', detail: task.sessionId ? '执行已中断，上下文已保存；可恢复原会话。' : '执行未能开始，原消息已保存在本机；可继续执行重试。' }, { type: 'task.error', label: '执行中断' });
    } finally {
      if (jobs.get(task.id)?.controller !== controller) return;
      if (task.recoveryPending) emit({ recoveryPending: false });
      jobs.delete(task.id);
      // Only completed work can advance the local queue or persistent goal.
      if (task.status === 'completed' && !task.pauseRequested && !locks.has(task.id)) {
        while (task.pendingMessages[0]?.source === 'goal' && task.goal?.status !== 'active') { task.pendingMessages.shift().delivery = 'cancelled'; }
        const next = task.pendingMessages.shift();
        if (next) {
          try { schedule(task, next, resolveAssets(next.assetIds || [])); }
          catch (cause) { next.delivery = 'failed'; update(task, { status: 'interrupted', error: redact(cause.message) }); }
        }
        else if (task.goal?.status === 'active') {
          const nextGoal = message('继续推进已设定的持续目标，检查已有结果并完成剩余工作。', [], 'goal');
          task.messages.push(nextGoal);
          schedule(task, nextGoal, []);
        }
      }
    }
  }
  function schedule(task, input, assets = [], recover = false) {
    assertConnection(task);
    if (jobs.has(task.id)) throw error(409, '会话正在执行，请排队发送或立即引导');
    const controller = new AbortController();
    if (input) { task.currentMessageId = input.id; input.timelineOrder ||= nextTimelineOrder(task); }
    const job = { controller };
    jobs.set(task.id, job);
    update(task, { status: recover ? 'recovering' : 'queued', recoveryPending: recover, collectingOutputs: false, pauseRequested: recover ? Boolean(task.pauseRequested) : false, error: undefined, detail: recover ? '正在恢复原会话，仅补查事件，不重发需求。' : '消息已保存，等待执行。' }, { type: recover ? 'session.recover' : 'message.queued', label: recover ? '恢复原会话' : '消息已排队' });
    job.done = taskQueue.enqueue(() => execute(task, input, assets, recover, controller), { signal: controller.signal }).catch(cause => {
      if (jobs.get(task.id) === job) { jobs.delete(task.id); update(task, { status: 'interrupted', recoveryPending: false, error: redact(cause.message) }); }
    });
    return task;
  }
  function create(body) {
    const prompt = validateText(body.prompt);
    const requestId = validateRequestId(body.requestId);
    const existing = requestId && tasks.find(item => item.requestId === requestId);
    if (existing) {
      if (existing.prompt !== prompt) throw error(409, '同一请求标识不能用于不同消息');
      return existing;
    }
    const assetIds = body.assetIds || [];
    const selected = resolveAssets(assetIds);
    if (body.mode && !['agent', 'plan'].includes(body.mode)) throw error(400, '无效会话模式');
    const task = prepare({ id: crypto.randomUUID(), requestId, prompt, options: validateOptions(body.options), assetIds, createdAt: now(), updatedAt: now(), status: 'queued', demo: !ark.config.configured, mode: body.mode || 'agent' });
    if (!task.demo) task.connectionScope = ark.config.connectionScope;
    task.messages[0].requestId = requestId;
    if (body.goal !== undefined) task.goal = newGoal(task, body.goal);
    tasks.unshift(task); persist();
    return schedule(task, task.messages[0], selected);
  }
  function postMessage(task, body) {
    assertConnection(task);
    if (locks.has(task.id) || task.status === 'pausing') throw error(409, '正在暂停会话，请稍候');
    if (task.status === 'terminated') throw error(409, '会话已终止，请新建会话');
    if (task.recoveryPending || task.status === 'recovering' || task.sessionId && (task.status === 'failed' || task.status === 'interrupted' && task.connection !== 'connected')) throw error(409, '请先恢复原会话，核实执行状态后再发送');
    if (task.status === 'waiting') throw error(409, '请先处理待确认的工具调用');
    if (task.status === 'interrupted' && task.stopReason === 'delivery_unknown') throw error(409, '上一条消息发送结果未确认，请先核实或点击「继续执行」，不会自动重发');
    if (task.status === 'interrupted' && task.stopReason === 'message_not_sent') throw error(409, '上一条消息尚未发送，请先点击「继续执行」');
    const text = validateText(body.prompt ?? body.text);
    const requestId = validateRequestId(body.requestId);
    const existing = requestId && task.messages.find(item => item.requestId === requestId);
    if (existing) {
      if (existing.text !== text) throw error(409, '同一请求标识不能用于不同消息');
      return task;
    }
    const selected = resolveAssets(body.assetIds || []);
    const mode = body.delivery || 'queue';
    if (!['queue', 'steer'].includes(mode)) throw error(400, '无效发送方式');
    if (body.mode && !['agent', 'plan'].includes(body.mode)) throw error(400, '无效会话模式');
    const input = { ...message(text, body.assetIds || [], body.source === 'goal' ? 'goal' : 'user'), requestId, options: validateOptions(body.options || task.options), mode: body.mode || task.mode, timelineOrder: nextTimelineOrder(task) };
    task.messages.push(input);
    if (busyStatus(task.status) || jobs.has(task.id)) {
      if (task.pendingMessages.length >= 20) { task.messages.pop(); throw error(409, '待发送队列已满'); }
      // Steering feeds the current cloud turn; queue waits for the next local turn.
      if (mode === 'steer' && task.status === 'running' && task.sessionId && !task.demo && !task.collectingOutputs && task.cloudTurnOpen) {
        input.delivery = 'sending'; input.timelineOrder ||= nextTimelineOrder(task); update(task, {}, { type: 'message.steer', label: '立即引导当前任务' });
        void ark.managed.sendMessage(task, input, selected, (patch, event) => update(task, patch, event)).catch(cause => update(task, { detail: `补充指令${input.delivery === 'unknown' ? '结果未确认，不会重发' : '发送失败'}：${redact(cause.message)}` }));
      } else { task.pendingMessages.push(input); update(task, {}, { type: 'message.queued', label: '下一条消息已排队' }); }
      return task;
    }
    return schedule(task, input, selected);
  }
  async function pause(task) {
    assertConnection(task);
    if (task.status === 'paused') return task;
    if (task.status === 'terminated') throw error(409, '会话已终止，不能暂停');
    if (locks.has(task.id)) throw error(409, '会话操作正在处理中');
    locks.add(task.id);
    const job = jobs.get(task.id);
    const previous = task.status;
    update(task, { pauseRequested: true, status: 'pausing', detail: '正在请求云端停止当前执行…' });
    if (task.goal?.status === 'active') task.goal.status = 'paused';
    try {
      if (!task.demo && task.sessionId) {
        await ark.managed.interrupt(task);
        // HTTP acceptance is not confirmation of interruption.
        const until = Date.now() + 15000;
        let idle = false;
        while (Date.now() < until) {
          const session = await ark.managed.getSession(task);
          if (session.status === 'idle') { idle = true; break; }
          if (['terminated', 'deleted'].includes(session.status)) throw error(409, '云端会话已终止');
          await sleep(200);
        }
        if (!idle) throw error(504, '中断已提交，但云端尚未确认停止；可恢复跟踪以核实状态');
      }
      job?.controller.abort(new Error('用户暂停'));
      if (job) { await job.done; if (jobs.get(task.id) === job) jobs.delete(task.id); }
      for (const input of task.pendingMessages) input.delivery = 'held';
      update(task, { status: 'paused', streamingText: '', streamingPreviews: [], detail: '已暂停。会话、目标、已完成内容和待发送消息均已保留。' }, { type: 'task.paused', label: '已暂停' });
      return task;
    } catch (cause) {
      job?.controller.abort(new Error('停止本机跟踪，等待核实云端中断结果'));
      if (job) { await job.done; if (jobs.get(task.id) === job) jobs.delete(task.id); }
      update(task, { status: previous === 'queued' && !task.sessionId ? 'queued' : 'interrupted', error: redact(cause.message), detail: '尚未确认云端暂停，请恢复原会话核实。' });
      throw cause;
    } finally { locks.delete(task.id); }
  }
  function resume(task, { recoverOnly = false } = {}) {
    assertConnection(task);
    if (locks.has(task.id)) throw error(409, '会话操作正在处理中');
    if (jobs.has(task.id)) return task;
    if (task.status === 'terminated') throw error(409, '会话已终止，请新建会话');
    if (task.status === 'waiting') throw error(409, '请先处理工具确认');
    if (!recoverOnly && task.sessionId && Object.values(task.referenceAssetResults || {}).some(item => item.status !== 'sent')) {
      task.pauseRequested = false;
      if (task.goal?.status === 'paused') task.goal.status = 'active';
      return schedule(task, undefined, [], true);
    }
    const recoveringCompletedGoal = recoverOnly && task.status === 'completed' && task.goal?.status === 'active';
    if (recoverOnly && !recoveringCompletedGoal && !['interrupted', 'failed', 'paused'].includes(task.status)) return task;
    if (recoveringCompletedGoal) return schedule(task, undefined, [], true);
    if (!task.demo && task.sessionId && (recoverOnly || ['interrupted', 'failed'].includes(task.status) && task.connection !== 'connected')) {
      return schedule(task, undefined, [], true);
    }
    if (task.stopReason === 'delivery_unknown') {
      for (const item of task.messages) if (['unknown', 'sending', 'queued'].includes(item.delivery) && !task.pendingMessages.some(pending => pending.id === item.id)) item.delivery = 'unconfirmed';
    }
    let next = task.pendingMessages.shift() || task.messages.find(item => item.delivery === 'queued' || item.delivery === 'held');
    if (!next) { next = message(task.stopReason === 'delivery_unknown' ? `原消息提交结果未确认，请先检查现有上下文与产物，在保留已有结果的前提下继续这项任务：${task.prompt}` : '继续刚才中断的任务，保留已有进度并完成剩余工作。'); task.messages.push(next); }
    next.delivery = 'queued';
    if (task.goal?.status === 'paused') task.goal.status = 'active';
    return schedule(task, next, resolveAssets(next.assetIds || []));
  }
  function setGoal(task, body) {
    if (!body.action || body.action === 'resume') assertConnection(task);
    if (locks.has(task.id)) throw error(409, '会话操作正在处理中');
    if (task.status === 'terminated') throw error(409, '会话已终止，请新建会话');
    if (body.action) {
      if (!task.goal) throw error(404, '当前会话还没有目标');
      const actions = { pause: 'paused', resume: 'active', complete: 'complete', remove: null, clear: null };
      if (!Object.hasOwn(actions, body.action)) throw error(400, '无效目标操作');
      if (body.action === 'resume' && ['complete', 'budget_exceeded'].includes(task.goal.status)) throw error(409, '请设置新目标或提高预算后继续');
      if (['remove', 'clear'].includes(body.action)) task.goal = null;
      else { task.goal.status = actions[body.action]; task.goal.updatedAt = now(); if (body.action === 'resume') delete task.goal.blockReason; }
      update(task, {}, { type: 'goal.updated', label: '目标状态已更新' });
      if (body.action === 'resume' && !busyStatus(task.status) && !['interrupted', 'waiting', 'terminated'].includes(task.status)) resume(task);
      return task;
    }
    const existingGoal = task.goal;
    task.goal = newGoal(task, body);
    if (existingGoal?.status === 'active' && busyStatus(task.status)) {
      for (let index = task.pendingMessages.length - 1; index >= 0; index--) if (task.pendingMessages[index].source === 'goal') { task.pendingMessages.splice(index, 1); }
    }
    update(task, {}, { type: existingGoal ? 'goal.updated' : 'goal.created', label: existingGoal ? '持续目标已编辑' : '持续目标已设置' });
    if (!['interrupted', 'failed', 'waiting', 'terminated'].includes(task.status) && (!busyStatus(task.status) || task.messages.some(item => item.delivery === 'sent'))) postMessage(task, { text: `持续推进这个目标：${task.goal.objective}`, delivery: 'queue', source: 'goal' });
    return task;
  }
  async function confirm(task, body) {
    assertConnection(task);
    if (task.status !== 'waiting' || !task.pendingApprovals.includes(body.toolUseId) || typeof body.allow !== 'boolean') throw error(400, '无效的工具确认');
    const confirmKey = `${task.id}:${body.toolUseId}`;
    if (confirming.has(confirmKey)) throw error(409, '上次工具确认结果未确认，请恢复原会话核实，不要重复提交');
    if (locks.has(task.id)) throw error(409, '工具确认正在处理中');
    locks.add(task.id); confirming.add(confirmKey);
    try {
      await ark.managed.confirm(task, body.toolUseId, body.allow);
      task.pendingApprovals = task.pendingApprovals.filter(id => id !== body.toolUseId);
      for (const step of [...(task.executionSteps || []), ...(task.toolCalls || [])]) if (step.id === body.toolUseId && !step.completedAt) { step.status = body.allow ? 'running' : 'denied'; step.confirmed = body.allow ? 'allow' : 'deny'; }
      update(task, {}, { type: 'tool.confirmed', label: body.allow ? '已允许工具调用' : '已拒绝工具调用' });
      if (!task.pendingApprovals.length) schedule(task, undefined, [], true);
      confirming.delete(confirmKey);
      return task;
    } catch (cause) {
      if (cause.status) confirming.delete(confirmKey);
      else { task.pendingApprovals = []; update(task, { status: 'interrupted', detail: '工具确认结果未确认，请恢复原会话补查历史。' }); }
      throw cause;
    } finally { locks.delete(task.id); }
  }
  function removeQueued(task, id) {
    const index = task.pendingMessages.findIndex(item => item.id === id);
    if (index < 0) throw error(404, '待发送消息不存在');
    const [input] = task.pendingMessages.splice(index, 1);
    input.delivery = 'cancelled'; update(task, {}, { type: 'message.cancelled', label: '已移除待发送消息' });
    return task;
  }
  function recoverStartup() {
    for (const task of tasks) {
      prepare(task);
      if (!busyStatus(task.status)) continue;
      if (task.sessionId && !task.demo) {
        update(task, { status: 'interrupted', error: undefined, detail: '服务已重启，正在恢复原会话跟踪。' });
        try { schedule(task, undefined, [], true); }
        catch (cause) { update(task, { status: 'interrupted', error: redact(cause.message), detail: '连接设置与原会话不匹配，请恢复原连接后继续。' }); }
      } else if (task.status === 'queued' && task.messages.some(item => item.delivery === 'queued')) {
        const input = task.messages.find(item => item.delivery === 'queued');
        try { schedule(task, input, resolveAssets(input.assetIds || [])); }
        catch (cause) { update(task, { status: 'interrupted', error: redact(cause.message) }); }
      } else update(task, { status: 'interrupted', detail: '服务已重启；消息未重新提交，可手动继续。' });
    }
  }
  return { create, find, summary, postMessage, pause, resume, setGoal, confirm, removeQueued, recoverStartup, jobs, assertConnection };
}
