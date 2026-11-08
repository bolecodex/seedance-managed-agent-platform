const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { config: {}, assets: [], tasks: [], verifications: [], avatarGroups: [], selected: new Set(), collection: 'virtual-avatar', queue: [], uploading: false, composerQueue: [], composerUploading: false, submitting: false, resultText: '', activeTaskId: null, activePrompt: '', viewedTask: null, taskMonitorError: false };
const activeTask = task => ['queued', 'running', 'pausing', 'recovering'].includes(task.status);
const taskStatus = { queued: '排队中', running: '创作中', completed: '已完成', failed: '未完成', paused: '已暂停', pausing: '正在暂停', interrupted: '连接已中断', recovering: '正在恢复', waiting: '等待确认', terminated: '会话已终止' };
const refreshingOutputs = new Set();
const localMessages = new Map();
let taskViewVersion = 0;
let historyPollTimer;
let historyRequest;
const templates = {
  product: { text: '为一家极简主义香氛品牌创作一张秋季主视觉。暖棕色调，自然光影，一只琥珀色玻璃瓶，传递安静、温暖的品牌气质。', style: '自然写实', ratio: '1:1' },
  film: { text: '为城市精品咖啡品牌设计一支 15 秒短片的分镜方案。清晨街角、窗边咖啡与自然上升的蒸汽，温暖电影感。请写明每个镜头的景别、运镜、时长与声音设计。', style: '电影质感', ratio: '16:9' },
  poster: { text: '为独立设计展创作一张品牌海报。以几何图形、酸性黄与雾蓝色形成鲜明对比，留出标题排版空间，构图简洁大胆，传递自由探索的精神。', style: '极简设计', ratio: '9:16' }
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatSize = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const fileIcon = type => type?.startsWith('image/') ? '▧' : type?.startsWith('video/') ? '▷' : type?.startsWith('audio/') ? '♫' : '▤';
const dateLabel = date => new Date(date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const selectableAsset = item => item.collection === 'reference' ? Boolean(item.arkFileId) : Boolean(item.assetId && item.remoteStatus === 'Active' && item.project === state.config.project);
let assetPollTimer;
let assetRefreshVersion = 0;
let toastTimer;
function toast(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  $('#toast').classList.toggle('error', error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4500);
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
let activeStream;
let draftScope = 'new';
let pendingSubmission;
let controlBusy = false;
let managingTaskId;
let draftsReady = false;
const terminalStatus = status => ['completed', 'failed', 'paused', 'interrupted', 'waiting', 'terminated'].includes(status);
const needsRecovery = task => Boolean(task?.sessionId && ['interrupted', 'failed'].includes(task.status) && task.connection !== 'connected');
function messageBlockReason(task) {
  if (!task) return '';
  if (task.status === 'waiting') return '请先允许或拒绝待确认的工具调用，当前草稿已保留';
  if (task.status === 'terminated') return '云端会话已终止，请新建会话后发送，当前草稿已保留';
  if (task.status === 'pausing') return '正在暂停会话，请稍候，当前草稿已保留';
  if (task.recoveryPending || task.status === 'recovering') return '正在恢复原会话，请稍候，当前草稿已保留';
  if (task.status === 'interrupted' && task.connection === 'connected') {
    if (task.stopReason === 'delivery_unknown') return '上一条消息发送结果未确认，请先核实或点击「继续执行」，当前草稿已保留';
    if (task.stopReason === 'message_not_sent') return '上一条消息尚未发送，请先点击「继续执行」，当前草稿已保留';
  }
  return '';
}
const taskName = task => task.title || task.prompt;
const taskStateLabel = task => task.status === 'interrupted' && task.connection === 'connected' ? task.stopReason === 'message_not_sent' ? '消息尚未发送' : '本轮已中断' : taskStatus[task.status] || '正在工作';
const cleanAgentText = value => String(value || '').replace(/<<GOAL_(COMPLETE|BLOCKED)>>/g, '').trim();
function storeDraft() {
  if (!draftsReady) return;
  try { localStorage.setItem(`visionary-draft:${draftScope}`, JSON.stringify({ text: $('#prompt').value, selected: [...state.selected], options: options(), mode: $('#agentMode').value, submission: pendingSubmission })); } catch {}
}
function switchDraft(scope) {
  if (draftScope === scope) return;
  storeDraft(); draftScope = scope;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(`visionary-draft:${scope}`) || 'null'); } catch {}
  pendingSubmission = saved?.submission || null;
  $('#prompt').value = saved?.text || ''; state.selected = new Set(saved?.selected || []); state.composerQueue = [];
  $('#agentMode').value = saved?.mode || 'agent';
  restoreOptions(saved?.options || {}); renderAttachments(); updateCount();
}
function subscribeTask(id) {
  if (activeStream?.taskId === id) return;
  activeStream?.close(); activeStream = null;
  if (!id) return;
  const source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/events`);
  source.taskId = id;
  source.addEventListener('task', event => {
    try {
      const task = JSON.parse(event.data);
      rememberTask(task);
      if (state.activeTaskId === id) displayTask(task);
    } catch (error) { console.warn('会话状态更新失败', error.message); }
  });
  source.onerror = () => {
    if (state.activeTaskId === id) $('#composerStatus').textContent = '连接中断，正在自动重连；草稿与云端会话已保留。';
  };
  activeStream = source;
}
function followupSetting() { return $('#followupMode').value; }
try { $('#followupMode').value = localStorage.getItem('visionary-followup') || 'queue'; } catch {}
$('#followupMode').onchange = () => { try { localStorage.setItem('visionary-followup', followupSetting()); } catch {} updateComposerActions(); };
$('#agentMode').onchange = async () => {
  storeDraft();
  if (!state.activeTaskId) return;
  try { const { task } = await taskAction('settings', { mode: $('#agentMode').value }); rememberTask(task); displayTask(task); }
  catch (error) { toast(error.message, true); }
};
function renderMarkdown(text) {
  // Only generate known tags from escaped text; model HTML is never trusted.
  const blocks = cleanAgentText(text).split(/(```[\s\S]*?```)/g);
  return blocks.map(block => {
    if (block.startsWith('```')) {
      const content = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
      return `<pre><code>${escapeHtml(content)}</code></pre>`;
    }
    return escapeHtml(block).replace(/^#{1,4} (.+)$/gm, '<h4>$1</h4>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>').replace(/\n/g, '<br>');
  }).join('');
}

const toolLabels = { image_generate: '生成图片', video_generate: '生成视频', compose_video: '合成视频', visual_search: '视觉搜索', general_search: '搜索资料', web_search: '搜索网页', web_fetch: '读取网页', todo_write: '更新执行计划', bash: '执行命令', read: '读取文件', write: '写入文件', edit: '编辑文件', glob: '查找文件', grep: '检索内容', skill: '加载技能', Skill: '加载技能' };
const executionOpenState = new Map();
const executionStatusLabels = { running: '执行中', completed: '已完成', failed: '失败', waiting: '等待确认', denied: '已拒绝', paused: '已暂停', interrupted: '待恢复', unconfirmed: '结果未确认', streaming: '实时更新' };
const executionTime = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '';
const durationLabel = (start, end) => {
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return '';
  const seconds = Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
  return seconds < 1 ? '< 1 秒' : seconds < 60 ? `${Math.round(seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
};
const usageTotal = usage => ['input_tokens', 'output_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (Number(usage?.[key]) || 0), 0) + Object.values(usage?.cache_creation || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
function executionStatus(step, task) {
  if (!['running', 'streaming', 'waiting'].includes(step.status)) return step.status || 'completed';
  if (task.pendingApprovals?.includes(step.id)) return 'waiting';
  if (task.status === 'paused') return 'paused';
  if (['interrupted', 'failed', 'terminated'].includes(task.status)) return 'interrupted';
  if (task.status === 'completed') return 'unconfirmed';
  return step.status;
}
function executionContent(content) {
  if (content === undefined) return '<p class="execution-note">工具已完成，平台未返回可展示的正文。</p>';
  if (!Array.isArray(content)) return `<pre>${escapeHtml(typeof content === 'string' ? content : JSON.stringify(content, null, 2))}</pre>`;
  if (!content.length) return '<p class="execution-note">工具已完成，平台未返回可展示的正文。</p>';
  return content.map(block => {
    if (block.type === 'text') return `<div class="execution-text">${renderMarkdown(block.text || '')}</div>`;
    if (block.type === 'search_result') {
      const url = safeUrl(block.source);
      return `<div class="execution-search">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(block.title || '搜索结果')} ↗</a>` : `<b>${escapeHtml(block.title || '搜索结果')}</b>`}${executionContent(block.content || [])}</div>`;
    }
    const source = block.source || {};
    const url = safeUrl(source.url);
    const label = block.title || ({ image: '图片', video: '视频', audio: '音频', document: '文档' }[block.type] || '工具产物');
    if (url && block.type === 'image') return `<a class="execution-media" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy">${escapeHtml(label)} ↗</a>`;
    if (url) return `<a class="execution-file" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`;
    if (source.type === 'text') return `<div class="execution-text">${escapeHtml(source.data || '')}</div>`;
    return `<p class="execution-note">${escapeHtml(label)}${source.file_id ? ` · ${escapeHtml(source.file_id)}` : ' · 已返回媒体内容'}</p>`;
  }).join('');
}
function renderExecutionStep(step, task) {
  const status = executionStatus(step, task);
  const title = step.kind === 'tool' ? toolLabels[step.name] || step.name || '工具执行结果' : step.title;
  const text = step.text || '';
  const summary = step.kind === 'tool' ? Object.values(step.input || {}).find(value => typeof value === 'string') || '' : text;
  const hasOutput = Object.hasOwn(step, 'output');
  const todos = step.name === 'todo_write' && Array.isArray(step.input?.todos) ? `<ul class="execution-todos">${step.input.todos.map(item => `<li><span>${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◔' : '○'}</span><b>${escapeHtml(item.content || item.text || '')}</b><small>${({ completed: '已完成', in_progress: '进行中', pending: '待执行' })[item.status] || '待执行'}</small></li>`).join('')}</ul>` : '';
  const body = step.kind === 'tool' ? `${todos}${step.input !== undefined ? `<div class="execution-section-label">输入参数</div><pre>${escapeHtml(JSON.stringify(step.input, null, 2))}</pre>` : ''}<div class="execution-section-label">${step.isError ? '错误信息' : '执行结果'}</div>${hasOutput || step.completedAt ? executionContent(step.output) : `<p class="execution-note">${status === 'waiting' ? '等待你的确认后执行。' : status === 'denied' ? '本次工具调用已拒绝。' : ['interrupted', 'paused', 'unconfirmed'].includes(status) ? '尚未收到完整工具结果，已有记录已保留。' : '工具正在执行，结果返回后会显示在这里。'}</p>`}` : text ? `<div class="execution-text">${renderMarkdown(text)}${step.status === 'streaming' ? '<span class="stream-caret"></span>' : ''}</div>` : step.kind === 'model' ? `<p class="execution-note">${step.usage ? `本次模型调用：输入 ${(step.usage.input_tokens || 0).toLocaleString()} · 输出 ${(step.usage.output_tokens || 0).toLocaleString()} tokens` : '等待模型返回结果。'}</p>` : `<p class="execution-note">${escapeHtml(step.stopReason || '会话事件已记录。')}</p>`;
  const key = `${task.id}:${step.id}`;
  const open = executionOpenState.get(key) ?? (step.status === 'streaming' || status === 'failed');
  return `<details class="execution-step status-${escapeHtml(status)}" data-execution-key="${escapeHtml(key)}" data-step-id="${escapeHtml(step.id)}"${open ? ' open' : ''}><summary><span class="execution-node" aria-hidden="true">${status === 'completed' ? '✓' : status === 'failed' ? '!' : step.kind === 'tool' ? '⌘' : step.kind === 'thinking' ? '✧' : '·'}</span><span class="execution-step-heading"><b>${escapeHtml(title || '执行记录')}</b>${step.kind === 'tool' ? `<code>${escapeHtml(step.name || step.type || 'tool')}</code>` : ''}<span class="execution-snippet">${escapeHtml(String(summary).replace(/\s+/g, ' ').slice(0, 100))}</span></span><span class="execution-step-meta"><span class="execution-step-status">${executionStatusLabels[status] || status}</span><time datetime="${escapeHtml(step.createdAt || '')}">${executionTime(step.createdAt)}</time>${step.completedAt ? `<small>${durationLabel(step.createdAt, step.completedAt)}</small>` : ''}</span><svg class="icon execution-chevron"><use href="#i-chevron"/></svg></summary><div class="execution-step-body">${step.threadId ? `<p class="execution-note execution-thread">线程 ${escapeHtml(step.threadId)}${step.name && step.kind === 'thread' ? ` · ${escapeHtml(step.name)}` : ''}</p>` : ''}${step.mcpServer ? `<p class="execution-note">MCP · ${escapeHtml(step.mcpServer)}</p>` : ''}${body}</div></details>`;
}
// Patch only changed entries so live updates preserve focus, disclosure state and scroll.
function reconcileExecutionGroup(node, replacement) {
  const existing = new Map([...node.querySelectorAll('details[data-execution-key]')].map(detail => [detail.dataset.executionKey, detail]));
  node.firstElementChild.innerHTML = replacement.firstElementChild.innerHTML;
  let previous = node.firstElementChild;
  for (const candidate of [...replacement.querySelectorAll('details[data-execution-key]')]) {
    const key = candidate.dataset.executionKey;
    const html = candidate.outerHTML;
    let detail = existing.get(key);
    if (!detail) detail = candidate;
    else if (detail._renderedHtml !== html) {
      detail.className = candidate.className;
      detail.open = candidate.open;
      for (const selector of ['summary', '.execution-step-body']) {
        const current = detail.querySelector(selector), next = candidate.querySelector(selector);
        if (current.innerHTML !== next.innerHTML) {
          const scrollTop = current.scrollTop;
          current.innerHTML = next.innerHTML;
          current.scrollTop = scrollTop;
        }
      }
    }
    detail._renderedHtml = html;
    detail.querySelector('summary').onclick = () => { executionOpenState.set(key, !detail.open); };
    if (previous.nextElementSibling !== detail) node.insertBefore(detail, previous.nextElementSibling);
    previous = detail; existing.delete(key);
  }
  for (const detail of existing.values()) detail.remove();
}
function reconcileTimeline(entries) {
  const timeline = $('#messageTimeline');
  const existing = new Map([...timeline.children].map(node => [node.dataset.timelineKey, node]));
  let previous = null;
  for (const { key, html } of entries) {
    let node = existing.get(key);
    if (!node || node._renderedHtml !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const replacement = template.content.firstElementChild;
      replacement.dataset.timelineKey = key; replacement._renderedHtml = html;
      if (node?.classList.contains('execution-group') && replacement.classList.contains('execution-group')) {
        reconcileExecutionGroup(node, replacement);
        node._renderedHtml = html;
      } else {
        for (const detail of replacement.querySelectorAll('details[data-execution-key]')) {
          detail._renderedHtml = detail.outerHTML;
          detail.querySelector('summary').onclick = () => { executionOpenState.set(detail.dataset.executionKey, !detail.open); };
        }
        if (node) node.replaceWith(replacement);
        node = replacement;
      }
    }
    const position = previous ? previous.nextElementSibling : timeline.firstElementChild;
    if (position !== node) timeline.insertBefore(node, position);
    previous = node; existing.delete(key);
  }
  for (const node of existing.values()) node.remove();
}

function renderReferenceCards(assetIds) {
  return assetIds.map((id, index) => {
    const asset = state.assets.find(item => item.id === id);
    const kind = asset?.type?.split('/')[0];
    const label = ({ image: '图片', video: '视频', audio: '音频' })[kind] || '文档';
    const name = asset?.name || `参考素材 ${index + 1}`;
    const url = asset?.hasLocalFile ? `/api/assets/${encodeURIComponent(id)}/content` : null;
    const icon = `<span class="message-asset-placeholder" aria-hidden="true"><span>${fileIcon(asset?.type)}</span><small>${asset ? label : '素材不可用'}</small></span>`;
    const media = url && kind === 'image' ? `<img class="message-asset-media" src="${url}" alt="${escapeHtml(name)}" loading="lazy">` : url && kind === 'video' ? `<video class="message-asset-media" src="${url}" preload="metadata" muted playsinline aria-label="${escapeHtml(name)}"></video><span class="message-asset-play" aria-hidden="true">▷</span>` : '';
    const detail = !asset ? '素材信息暂不可用' : !url ? `${label} · 仅云端素材` : `${label}${asset.size ? ` · ${formatSize(asset.size)}` : ''}`;
    const content = `<div class="message-asset-preview">${icon}${media}<span class="message-asset-order" aria-hidden="true">${index + 1}</span></div><div class="message-asset-info"><b title="${escapeHtml(name)}">${escapeHtml(name)}</b><small>${escapeHtml(detail)}${url ? '<span aria-hidden="true">↗</span>' : ''}</small></div>`;
    return `<div class="message-asset${url ? '' : ' unavailable'}" role="listitem" data-reference-id="${escapeHtml(id)}">${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" aria-label="预览参考素材 ${index + 1}：${escapeHtml(name)}">${content}</a>` : content}</div>`;
  }).join('');
}
function renderMessageReferences(assetIds = []) {
  return assetIds.length ? `<div class="message-references" role="list" aria-label="引用的参考素材">${renderReferenceCards(assetIds)}</div>` : '';
}
async function copyMessage(message) {
  if (!message) return;
  const text = message.role === 'user' ? String(message.text || '') : cleanAgentText(message.text);
  const assetIds = [...new Set(message.assetIds || [])];
  if (!assetIds.length) {
    await navigator.clipboard.writeText(text);
    try { localStorage.removeItem('visionary-copied-message'); } catch {}
    toast('已复制消息');
    return;
  }
  const payload = { version: 1, origin: location.origin, text, assetIds };
  const references = assetIds.map((id, index) => {
    const asset = state.assets.find(item => item.id === id);
    return { name: asset?.name || `参考素材 ${index + 1}`, type: asset?.type, url: asset?.hasLocalFile ? new URL(`/api/assets/${encodeURIComponent(id)}/content`, location.origin).href : '' };
  });
  const clipboardText = `${text}\n\n[引用素材]\n${references.map((item, index) => `${index + 1}. ${item.name}${item.url ? `\n${item.url}` : ''}`).join('\n')}`;
  const html = `<div data-visionary-message="${escapeHtml(JSON.stringify(payload))}"><div style="white-space:pre-wrap">${escapeHtml(text)}</div><ol>${references.map(item => `<li>${item.url ? `<a href="${escapeHtml(item.url)}">${item.type?.startsWith('image/') ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" width="240"><br>` : ''}${escapeHtml(item.name)}</a>` : escapeHtml(item.name)}</li>`).join('')}</ol></div>`;
  let richCopy = false;
  if (navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([clipboardText], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      richCopy = true;
    } catch { /* Text and the local reference bundle still work without rich clipboard access. */ }
  }
  if (!richCopy) await navigator.clipboard.writeText(clipboardText);
  // Preserve references across tabs and reloads when a browser only supports text clipboard writes.
  try { localStorage.setItem('visionary-copied-message', JSON.stringify({ ...payload, clipboardText })); } catch {}
  toast(`已复制提示词与 ${assetIds.length} 份引用素材`);
}
function copiedMessage(data) {
  let payload;
  try {
    const html = data.getData('text/html');
    const encoded = html && new DOMParser().parseFromString(html, 'text/html').querySelector('[data-visionary-message]')?.getAttribute('data-visionary-message');
    if (encoded) payload = JSON.parse(encoded);
    else {
      const saved = JSON.parse(localStorage.getItem('visionary-copied-message') || 'null');
      if (saved?.clipboardText === data.getData('text/plain')) payload = saved;
    }
  } catch { return null; }
  return payload?.version === 1 && payload.origin === location.origin && typeof payload.text === 'string' && Array.isArray(payload.assetIds) && payload.assetIds.length && payload.assetIds.every(id => typeof id === 'string' && id) ? payload : null;
}
async function pasteMessage(payload) {
  const prompt = $('#prompt');
  const scope = draftScope, version = taskViewVersion;
  prompt.setRangeText(payload.text, prompt.selectionStart, prompt.selectionEnd, 'end');
  prompt.focus({ preventScroll: true });
  updateCount();
  if (payload.assetIds.some(id => !state.assets.some(item => item.id === id))) {
    try { await refreshAssets(); } catch { /* Restore available references and report the rest below. */ }
  }
  if (scope !== draftScope || version !== taskViewVersion) return;
  let unavailable = 0;
  for (const id of new Set(payload.assetIds)) {
    const asset = state.assets.find(item => item.id === id);
    if (asset && selectableAsset(asset)) state.selected.add(id);
    else unavailable++;
  }
  renderAssets(); renderAttachments();
  toast(unavailable ? `已粘贴提示词，${unavailable} 份引用素材已删除或暂不可用，请重新选择` : `已粘贴提示词与 ${new Set(payload.assetIds).size} 份引用素材`, Boolean(unavailable));
}
$('#messageTimeline').addEventListener('error', event => {
  if (!event.target.matches('.message-asset-media')) return;
  event.target.classList.add('hidden');
  event.target.parentElement.querySelector('.message-asset-placeholder small').textContent = '预览不可用';
  event.target.parentElement.querySelector('.message-asset-play')?.classList.add('hidden');
}, true);

function renderConversation(task, { revealRequestId } = {}) {
  const scroll = $('#studioScroll');
  const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
  const savedMessages = task.messages || [{ id: 'legacy-user', role: 'user', text: task.prompt, assetIds: task.assetIds || [] }, ...(task.result ? [{ id: 'legacy-assistant', role: 'assistant', text: task.result }] : [])];
  const messages = [...savedMessages, ...[...localMessages.values()].filter(item => item.taskId === (task.id || null) && !savedMessages.some(saved => saved.requestId === item.requestId))];
  const queued = task.pendingMessages || [];
  const queuedIds = new Set(queued.map(item => item.id));
  const visible = messages.filter(item => item.delivery !== 'cancelled');
  const deliveryLabels = { queued: '已保存 · 等待发送', held: '已保留 · 尚未发送', sending: '发送中', unknown: '结果未确认 · 已保存', unconfirmed: '结果未确认 · 已保存', failed: '发送失败 · 已保存', local_failed: '发送失败 · 草稿已保留' };
  const steps = [...(task.executionSteps || [])];
  for (const tool of task.toolCalls || []) if (!steps.some(step => step.id === tool.id)) steps.push({ ...tool, kind: 'tool' });
  const previews = activeTask(task) ? task.streamingPreviews || [] : [];
  for (const preview of previews) if (preview.type === 'agent.thinking' && !steps.some(step => step.id === preview.id)) steps.push({ ...preview, kind: 'thinking', title: '思考与规划', status: 'streaming' });
  const ordered = [...visible.map(item => ({ ...item, entryType: 'message' })), ...steps.map(item => ({ ...item, entryType: 'execution' })), ...previews.filter(item => item.type === 'agent.message' && !visible.some(message => message.id === item.id)).map(item => ({ ...item, entryType: 'preview' }))].sort((a, b) => (a.timelineOrder || 0) - (b.timelineOrder || 0));
  if (!previews.some(item => item.type === 'agent.message') && task.streamingText && activeTask(task)) ordered.push({ id: 'legacy-preview', text: task.streamingText, entryType: 'preview' });
  const entries = [];
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    if (item.entryType === 'execution') {
      const group = [item];
      while (ordered[index + 1]?.entryType === 'execution') group.push(ordered[++index]);
      entries.push({ key: `execution:${item.id}`, html: `<section class="execution-group" aria-label="Agent 执行过程"><div class="execution-group-heading"><span>✧</span> 执行过程 <small>${group.length} 条记录</small></div>${group.map(step => renderExecutionStep(step, task)).join('')}</section>` });
    } else if (item.entryType === 'preview') entries.push({ key: `message:${item.id}`, html: `<article class="chat-message chat-assistant streaming"><div class="chat-message-heading"><b>Seedance Managed Agent</b><small>正在回复</small></div><div class="chat-message-content">${renderMarkdown(item.text)}<span class="stream-caret"></span></div></article>` });
    else {
      const references = renderMessageReferences(item.assetIds);
      const deliveryLabel = queuedIds.has(item.id) && item.delivery === 'queued' ? '已排队 · 当前轮次结束后发送' : deliveryLabels[item.delivery];
      const message = `<article class="chat-message ${item.role === 'user' ? 'chat-user' : 'chat-assistant'}" data-message-id="${escapeHtml(item.id)}" data-request-id="${escapeHtml(item.requestId || '')}"><div class="chat-message-heading"><b>${item.role === 'user' ? item.source === 'goal' ? '目标 · 自动继续' : '你' : task.demo ? '交互演示' : 'Seedance Managed Agent'}</b><small>${item.createdAt ? dateLabel(item.createdAt) : ''}${deliveryLabel ? ` · ${deliveryLabel}` : ''}</small><button class="message-copy" data-copy-message="${escapeHtml(item.id)}" title="${item.assetIds?.length ? '复制提示词与引用素材' : '复制消息'}">复制</button>${item.role === 'user' ? `<button class="message-copy" data-edit-message="${escapeHtml(item.id)}" title="编辑为新的补充消息">编辑</button>` : ''}</div><div class="chat-message-content">${item.role === 'user' ? escapeHtml(item.text) : renderMarkdown(item.text)}</div>${item.assetIds?.length ? `<small class="message-assets">引用 ${item.assetIds.length} 份素材</small>` : ''}</article>`;
      entries.push({ key: `message:${item.requestId || item.id}`, html: references ? `<div class="chat-turn${item.role === 'user' ? ' chat-turn-user' : ''}">${references}${message}</div>` : message });
    }
  }
  reconcileTimeline(entries);
  $$('[data-copy-message]').forEach(button => button.onclick = async () => { try { await copyMessage(messages.find(item => item.id === button.dataset.copyMessage)); } catch { toast('复制失败，请检查浏览器剪贴板权限', true); } });
  $$('[data-edit-message]').forEach(button => button.onclick = () => { const item = messages.find(item => item.id === button.dataset.editMessage); $('#prompt').value = item.text; state.selected = new Set(item.assetIds || []); renderAttachments(); updateCount(); $('#prompt').focus(); });
  $('#pendingMessages').classList.toggle('hidden', !queued.length);
  $('#pendingMessages').innerHTML = queued.map(item => `<div class="pending-message"><span>↳</span><p>${escapeHtml(item.text)}</p><small>${item.delivery === 'held' ? '已保留' : '下一条'}</small><button data-remove-message="${escapeHtml(item.id)}" aria-label="移除待发送消息">×</button></div>`).join('');
  $$('[data-remove-message]').forEach(button => button.onclick = async () => {
    try { const { task: updated } = await api(`/api/tasks/${encodeURIComponent(task.id)}/messages/${encodeURIComponent(button.dataset.removeMessage)}`, { method: 'DELETE' }); rememberTask(updated); displayTask(updated); } catch (error) { toast(error.message, true); }
  });
  const goal = task.goal;
  const goalLabels = { active: '持续推进中', paused: '已暂停', complete: '已完成', blocked: '需要你处理', budget_exceeded: '已达到预算' };
  $('#goalCard').classList.toggle('hidden', !goal);
  if (goal) {
    $('#goalCard').innerHTML = `<div class="goal-topline"><span>◎ 持续目标</span><b>${goalLabels[goal.status] || goal.status}</b><button id="editGoal" aria-label="编辑持续目标">编辑</button></div><p>${escapeHtml(goal.objective)}</p>${goal.blockReason ? `<p class="goal-block-reason">${escapeHtml(goal.blockReason)}</p>` : ''}<div class="goal-meta"><span>已推进 ${goal.turns || 0} 轮${goal.tokenBudget ? ` · ${(goal.tokensUsed || 0).toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens` : ''}</span><div>${goal.status === 'active' ? '<button data-goal-action="pause">暂停目标</button>' : ['paused', 'blocked'].includes(goal.status) ? '<button data-goal-action="resume">继续目标</button>' : ''}${goal.status !== 'complete' ? '<button data-goal-action="complete">标记完成</button>' : ''}<button data-goal-action="remove">移除</button></div></div>`;
    $('#editGoal').onclick = openGoal;
    $$('[data-goal-action]').forEach(button => button.onclick = () => controlTask('goal', { action: button.dataset.goalAction }));
  }
  const recoverable = ['paused', 'interrupted', 'failed', 'terminated'].includes(task.status) || task.status === 'completed' && task.goal?.status === 'active';
  $('#recoveryPanel').classList.toggle('hidden', !recoverable);
  const recoverGoal = task.status === 'completed' && task.goal?.status === 'active';
  $('#recoveryPanel').innerHTML = recoverable ? `<div><b>${recoverGoal ? '目标尚未完成' : taskStateLabel(task)}</b><p>${escapeHtml(task.error ? `${task.error} 原消息与会话记录已保存在本机。` : recoverGoal ? '会话已完成，持续目标仍在推进。' : task.detail || '已保存会话上下文。')}</p></div>${task.status !== 'terminated' ? `<button id="resumeTask" class="text-button">${recoverGoal ? '继续目标' : needsRecovery(task) ? '恢复会话跟踪' : '继续执行'} ↗</button>` : ''}` : '';
  if ($('#resumeTask')) $('#resumeTask').onclick = () => controlTask(recoverGoal || needsRecovery(task) ? 'recover' : 'resume');
  $('#approvalPanel').classList.toggle('hidden', task.status !== 'waiting');
  $('#approvalPanel').innerHTML = task.status === 'waiting' ? (task.pendingApprovals || []).map(id => {
    const tool = task.toolCalls?.find(item => item.id === id);
    return `<div class="approval-item"><b>允许调用 ${escapeHtml(tool?.name || '工具')}？</b><pre>${escapeHtml(JSON.stringify(tool?.input || {}, null, 2))}</pre><button data-confirm="${escapeHtml(id)}" data-allow="true">允许本次</button><button data-confirm="${escapeHtml(id)}" data-allow="false">拒绝</button></div>`;
  }).join('') : '';
  $$('[data-confirm]').forEach(button => button.onclick = () => controlTask('confirm', { toolUseId: button.dataset.confirm, allow: button.dataset.allow === 'true' }));
  if (nearEnd || revealRequestId) {
    const version = taskViewVersion;
    requestAnimationFrame(() => {
      if (version !== taskViewVersion) return;
      const message = revealRequestId && $$('[data-request-id]').find(node => node.dataset.requestId === revealRequestId);
      if (message) message.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      else scroll.scrollTop = scroll.scrollHeight;
    });
  }
  updateComposerActions();
}
function taskAction(action, body = {}, id = state.activeTaskId) {
  if (!id) throw new Error('请先打开一个会话');
  return api(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function controlTask(action, body = {}) {
  if (controlBusy) return;
  const id = state.activeTaskId;
  controlBusy = true; updateComposerActions();
  try { const { task } = await taskAction(action, body, id); rememberTask(task); displayTask(task); toast(action === 'pause' ? '已暂停，会话进度已保留' : action === 'recover' ? '正在恢复原会话，不重发原始需求' : '会话已更新'); }
  catch (error) { toast(error.message, true); }
  finally { controlBusy = false; updateComposerActions(); }
}
$('#pauseBtn').onclick = () => controlTask('pause');
function openGoal() {
  const goal = state.viewedTask?.goal;
  $('#goalDialog').dataset.editing = String(Boolean(goal));
  $('#goalObjective').value = goal?.objective || '';
  $('#goalBudget').value = goal?.tokenBudget || '';
  $('#goalDialog').showModal(); $('#goalObjective').focus();
}
$('#goalButton').onclick = openGoal;
$('#closeGoal').onclick = () => $('#goalDialog').close();
$('#goalForm').onsubmit = async event => {
  event.preventDefault();
  if ($('#saveGoal').disabled) return;
  $('#saveGoal').disabled = true;
  try {
    const objective = $('#goalObjective').value.trim();
    const body = { objective, ...($('#goalBudget').value ? { tokenBudget: Number($('#goalBudget').value) } : {}) };
    let id = state.activeTaskId;
    let task;
    if (!id) {
      const signature = JSON.stringify({ goal: body, mode: $('#agentMode').value, options: options(), assetIds: [...state.selected] });
      if (pendingSubmission?.signature !== signature) pendingSubmission = { signature, requestId: crypto.randomUUID() };
      storeDraft();
      ({ task } = await api('/api/creative', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: objective, goal: body, mode: $('#agentMode').value, options: options(), assetIds: [...state.selected], requestId: pendingSubmission.requestId }) }));
      pendingSubmission = null;
      rememberTask(task); id = task.id;
      switchDraft(id); state.activeTaskId = id; state.viewedTask = null; beginConversation(task.prompt, id); subscribeTask(id);
    } else if (state.viewedTask?.status === 'interrupted' || needsRecovery(state.viewedTask)) {
      const recovered = await taskAction('recover', {}, id);
      const updated = await taskAction('goal', body, id);
      task = updated.task || recovered.task;
    } else ({ task } = await taskAction('goal', body, id));
    rememberTask(task); displayTask(task);
    $('#goalDialog').close(); goStudio(); toast('持续目标已保存');
  } catch (error) { toast(error.message, true); }
  finally { $('#saveGoal').disabled = false; }
};
const slashCommands = [{ command: '/goal', label: '设置持续目标' }, { command: '/pause', label: '暂停当前会话' }, { command: '/resume', label: '继续当前会话' }, { command: '/new', label: '新建会话' }, { command: '/plan', label: '先制定计划' }, { command: '/agent', label: '切换 Agent 模式' }, { command: '/fork', label: '复制当前会话' }, { command: '/rename', label: '重命名当前会话' }, { command: '/archive', label: '归档当前会话' }, { command: '/pin', label: '置顶当前会话' }, { command: '/clear', label: '清空本机会话记录' }];
function renderCommands() {
  const text = $('#prompt').value.trim();
  const items = text.startsWith('/') && !text.includes(' ') ? slashCommands.filter(item => item.command.startsWith(text)) : [];
  $('#slashCommands').classList.toggle('hidden', !items.length);
  $('#slashCommands').innerHTML = items.map(item => `<button role="menuitem" data-command="${item.command}"><b>${item.command}</b><span>${item.label}</span></button>`).join('');
  $$('[data-command]').forEach(button => button.onclick = () => { $('#prompt').value = button.dataset.command; run(); });
}
async function handleCommand(text) {
  if (!text.startsWith('/')) return false;
  const [command, ...rest] = text.split(/\s+/);
  if (!slashCommands.some(item => item.command === command)) return false;
  $('#prompt').value = ''; updateCount(); renderCommands();
  if (command === '/goal') { openGoal(); if (rest.length) $('#goalObjective').value = rest.join(' '); }
  if (command === '/pause') await controlTask('pause');
  if (command === '/resume') await controlTask(needsRecovery(state.viewedTask) || state.viewedTask?.status === 'completed' && state.viewedTask?.goal?.status === 'active' ? 'recover' : 'resume');
  if (command === '/new') newTask();
  if (command === '/fork') forkTask();
  if (command === '/rename') { openThreadSettings(state.activeTaskId); $('#threadTitle').focus(); }
  if (command === '/archive') { try { const { task } = await taskAction('metadata', { archived: true }); rememberTask(task); } catch (error) { toast(error.message, true); } }
  if (command === '/pin') { try { const { task } = await taskAction('metadata', { pinned: !state.viewedTask?.pinned }); rememberTask(task); } catch (error) { toast(error.message, true); } }
  if (command === '/clear') { if (!state.activeTaskId) newTask(); else { if (!confirm('清空这条本机对话记录？云端会话和产物不会删除。')) return true; try { await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}`, { method: 'DELETE' }); state.tasks = state.tasks.filter(task => task.id !== state.activeTaskId); newTask(); } catch (error) { toast(error.message, true); } } }
  if (command === '/plan' || command === '/agent') { $('#agentMode').value = command.slice(1); storeDraft(); if (state.activeTaskId) await $('#agentMode').onchange(); toast(command === '/plan' ? '计划模式已选择；发送下一条消息后生效' : 'Agent 模式已选择；发送下一条消息后生效'); }
  return true;
}
async function forkTask() {
  const source = state.viewedTask;
  if (!source) return toast('请先打开要复制的会话', true);
  try {
    const { task } = await api('/api/conversations/fork', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: source.id }) });
    rememberTask(task); await openTask(task.id); toast('会话与对话上下文已复制');
  } catch (error) { toast(error.message, true); }
}
function openThreadSettings(id) {
  managingTaskId = id; const task = state.tasks.find(item => item.id === id);
  $('#threadTitle').value = taskName(task);
  $('#pinThread').textContent = task.pinned ? '取消置顶' : '置顶';
  $('#archiveThread').textContent = task.archived ? '取消归档' : '归档';
  $('#threadDialog').showModal();
}
$('#closeThread').onclick = () => $('#threadDialog').close();
async function changeThread(patch) {
  try { const { task } = await taskAction('metadata', patch, managingTaskId); rememberTask(task); displayTask(task); $('#threadDialog').close(); }
  catch (error) { toast(error.message, true); }
}
$('#threadForm').onsubmit = event => { event.preventDefault(); changeThread({ title: $('#threadTitle').value }); };
$('#pinThread').onclick = () => changeThread({ pinned: !state.tasks.find(item => item.id === managingTaskId).pinned });
$('#archiveThread').onclick = () => changeThread({ archived: !state.tasks.find(item => item.id === managingTaskId).archived });
$('#deleteThread').onclick = async () => {
  const id = managingTaskId;
  if (!confirm('删除这条本机会话记录？云端 Session 和文件会保留。')) return;
  try { await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }); state.tasks = state.tasks.filter(item => item.id !== id); if (state.activeTaskId === id) newTask(); renderHistory(); $('#threadDialog').close(); } catch (error) { toast(error.message, true); }
};
$('#showArchived').onchange = renderHistory;
window.addEventListener('beforeunload', storeDraft);

function updateCount() {
  $('#charCount').textContent = $('#prompt').value.length;
  $('#prompt').style.height = 'auto';
  const maximum = Number.parseFloat(getComputedStyle($('#prompt')).maxHeight) || 180;
  $('#prompt').style.height = `${Math.min(maximum, Math.max(57, $('#prompt').scrollHeight))}px`;
  try { localStorage.setItem('visionary-draft', $('#prompt').value); } catch {}
  storeDraft(); renderCommands(); updateComposerActions();
}
function setTheme(theme, persist = false) {
  const isLight = theme === 'light';
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  const nextLabel = `切换到${isLight ? '夜间' : '日间'}模式`;
  $('#themeToggle').setAttribute('aria-label', nextLabel);
  $('#themeToggle').title = nextLabel;
  $('meta[name="theme-color"]').content = isLight ? '#f4f6f2' : '#181917';
  $('meta[name="color-scheme"]').content = isLight ? 'light' : 'dark';
  if (persist) {
    try { localStorage.setItem('visionary-theme', isLight ? 'light' : 'dark'); } catch {}
  }
}
setTheme(document.documentElement.dataset.theme);
$('#themeToggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
function syncOptionSummary() {
  const selected = options();
  $('#styleSummary').firstChild.textContent = `${selected.style} `;
  $('#ratioSummary').textContent = selected.aspectRatio;
}
function setOption(selector, value, className, readValue) {
  $$(selector).forEach(button => {
    const selected = readValue(button) === value;
    button.classList.toggle(className, selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  syncOptionSummary();
}
function options() {
  return { aspectRatio: $('[data-ratio].selected').dataset.ratio, style: $('.style.active').textContent, optimize: $('[data-toggle="optimize"]').classList.contains('on'), versions: $('[data-toggle="versions"]').classList.contains('on') };
}
function restoreOptions(settings = {}) {
  setOption('[data-ratio]', settings.aspectRatio || '1:1', 'selected', button => button.dataset.ratio);
  setOption('.style', settings.style || '自然写实', 'active', button => button.textContent);
  $$('.toggle').forEach(button => {
    const checked = button.dataset.toggle === 'optimize' ? settings.optimize !== false : Boolean(settings.versions);
    button.classList.toggle('on', checked);
    button.setAttribute('aria-checked', String(checked));
  });
}
const viewMeta = {
  studio: ['工作空间', '新建创作', '今天，想创造一点什么？'],
  assets: ['工作空间', '素材资产库', '让参考有序，让创作自由。'],
  history: ['工作空间', '历史任务', '记录每一次探索，也为下一次积累。']
};
function showView() {
  const view = Object.hasOwn(viewMeta, location.hash.slice(1)) ? location.hash.slice(1) : 'studio';
  Object.keys(viewMeta).forEach(name => $(`#${name}View`).classList.toggle('hidden', name !== view));
  $$('[data-view]').forEach(link => { link.classList.toggle('active', link.dataset.view === view); if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#breadcrumbName').textContent = viewMeta[view][0];
  $('#pageTitle').textContent = view === 'studio' && state.activePrompt ? state.activePrompt : viewMeta[view][1];
  $('#pageTitle').title = $('#pageTitle').textContent;
  $('#pageDescription').textContent = viewMeta[view][2];
  $('#preferencesToggle').classList.toggle('hidden', view !== 'studio');
  $('#headerNewTask').classList.toggle('hidden', view === 'studio' && !state.activePrompt);
  closeSidebar(false);
  updateCount();
  if (view === 'assets') refreshAssets().catch(error => toast(error.message, true));
  if (view === 'assets' && state.config.avatarLibraryConfigured) refreshAvatarGroups().catch(error => { $('#avatarGroupStatus').textContent = error.message; });
  if (view === 'history') refreshHistory().catch(error => toast(error.message, true));
}
function goStudio() { location.hash = 'studio'; showView(); }
function focusComposer() { goStudio(); $('#prompt').focus({ preventScroll: true }); updateCount(); }
function closeSidebar(restoreFocus = true) {
  document.body.classList.remove('sidebar-mobile-open');
  $('#sidebarBackdrop').classList.add('hidden');
  syncSidebar();
  if (restoreFocus && matchMedia('(max-width: 760px)').matches) $('#sidebarOpen').focus();
}
function syncSidebar() {
  const mobile = matchMedia('(max-width: 760px)').matches;
  const open = document.body.classList.contains('sidebar-mobile-open');
  const visible = mobile ? open : !document.body.classList.contains('sidebar-collapsed');
  $('#sidebar').inert = mobile && !open;
  $('#main').inert = mobile && open;
  $('#sidebarOpen').setAttribute('aria-expanded', String(visible));
  $('#sidebarToggle').setAttribute('aria-label', mobile ? '关闭导航菜单' : '收起侧边栏');
  $('#sidebarToggle').title = mobile ? '关闭导航菜单' : '收起侧边栏';
  $('#sidebarBackdrop').classList.toggle('hidden', !mobile || !open);
}
$('#sidebarToggle').onclick = () => {
  if (matchMedia('(max-width: 760px)').matches) return closeSidebar();
  document.body.classList.add('sidebar-collapsed');
  try { localStorage.setItem('visionary-sidebar-collapsed', 'true'); } catch {}
  syncSidebar(); $('#sidebarOpen').focus();
};
$('#sidebarOpen').onclick = () => {
  if (matchMedia('(max-width: 760px)').matches) {
    document.body.classList.add('sidebar-mobile-open'); syncSidebar(); $('#sidebarToggle').focus();
  } else {
    document.body.classList.remove('sidebar-collapsed');
    try { localStorage.setItem('visionary-sidebar-collapsed', 'false'); } catch {}
    syncSidebar(); $('#sidebarToggle').focus();
  }
};
$('#sidebarBackdrop').onclick = () => closeSidebar();
$('#sidebar').addEventListener('click', event => {
  if (event.target.closest('a[href^="#"]') && document.body.classList.contains('sidebar-mobile-open')) {
    closeSidebar(false);
    $('#main').focus({ preventScroll: true });
  }
});
try { document.body.classList.toggle('sidebar-collapsed', localStorage.getItem('visionary-sidebar-collapsed') === 'true'); } catch {}
function syncPreferences() {
  const open = !$('#preferencesPanel').classList.contains('hidden');
  const overlay = matchMedia('(max-width: 980px)').matches;
  $('#preferencesBackdrop').classList.toggle('hidden', !open || !overlay);
  $('#preferencesToggle').setAttribute('aria-expanded', String(open));
  $('#studioView').classList.toggle('preferences-open', open);
  $('.studio-primary').inert = open && overlay;
}
function togglePreferences(force) {
  const open = force ?? $('#preferencesPanel').classList.contains('hidden');
  $('#preferencesPanel').classList.toggle('hidden', !open);
  syncPreferences();
  if (open) $('#closePreferences').focus();
  else $('#preferencesToggle').focus();
}
$('#preferencesToggle').onclick = () => togglePreferences();
$('#closePreferences').onclick = () => togglePreferences(false);
$('#preferencesBackdrop').onclick = () => togglePreferences(false);
$('#styleSummary').onclick = $('#ratioSummary').onclick = () => togglePreferences(true);
window.addEventListener('resize', () => { syncSidebar(); syncPreferences(); updateCount(); });
function beginConversation(prompt, taskId = null) {
  state.activePrompt = prompt; state.activeTaskId = taskId;
  if (taskId) { try { localStorage.setItem('visionary-active-task', taskId); } catch {} subscribeTask(taskId); }
  $('#studioWelcome').classList.add('hidden');
  $('#conversation').classList.remove('hidden');
  $('#conversationPrompt').textContent = prompt;
  if (!$('#studioView').classList.contains('hidden')) { $('#pageTitle').textContent = prompt; $('#pageTitle').title = prompt; }
  $('#headerNewTask').classList.remove('hidden');
  $('#composerStatus').textContent = '把每一个想法，继续向前推进。';
  renderRecentTasks();
}
window.addEventListener('hashchange', showView);
$('#heroStart').onclick = focusComposer;
$('#prompt').oninput = updateCount;
try {
  const saved = JSON.parse(localStorage.getItem('visionary-draft:new') || 'null');
  if (saved) { $('#prompt').value = saved.text || ''; state.selected = new Set(saved.selected || []); pendingSubmission = saved.submission || null; $('#agentMode').value = saved.mode || 'agent'; restoreOptions(saved.options || {}); }
  else { const draft = localStorage.getItem('visionary-draft'); if (draft !== null) $('#prompt').value = draft; }
} catch {}
draftsReady = true; updateCount();
$$('[data-template]').forEach(button => button.onclick = () => {
  const template = templates[button.dataset.template];
  $('#prompt').value = template.text;
  restoreOptions({ style: template.style, aspectRatio: template.ratio });
  updateCount(); focusComposer(); toast('已填入灵感模板，可继续自由修改');
});
$$('[data-ratio]').forEach(button => button.onclick = () => setOption('[data-ratio]', button.dataset.ratio, 'selected', item => item.dataset.ratio));
$$('.style').forEach(button => button.onclick = () => setOption('.style', button.textContent, 'active', item => item.textContent));
$$('.toggle').forEach(button => button.onclick = () => { const checked = button.classList.toggle('on'); button.setAttribute('aria-checked', String(checked)); });
$('#resetSettings').onclick = () => { restoreOptions(); toast('创作偏好已重置'); };
$('#polish').onclick = () => {
  if (!$('#prompt').value.trim()) return toast('先写下一点你的想法', true);
  const suffix = ` 画面采用${options().style}风格，重视主体层次、自然光影与留白，保留品牌识别度。`;
  if ($('#prompt').value.includes('重视主体层次')) return toast('描述已润色，可以开始创作了');
  $('#prompt').value += suffix; updateCount(); toast('已本地补充风格、构图和光影描述');
};
function newTask() {
  if (state.composerUploading) return toast('参考素材正在上传，请等待完成', true);
  taskViewVersion++; state.viewedTask = null; subscribeTask(null);
  switchDraft('new');
  try { localStorage.removeItem('visionary-active-task'); } catch {}
  $('#pendingMessages').classList.add('hidden');
  renderAttachments(); updateCount();
  state.activePrompt = ''; state.activeTaskId = null; state.resultTaskId = null;
  $('#result').classList.add('hidden'); $('#progress').classList.add('hidden');
  $('#conversation').classList.add('hidden'); $('#studioWelcome').classList.remove('hidden');
  if (!$('#preferencesPanel').classList.contains('hidden')) togglePreferences(false);
  updateComposerActions();
  renderRecentTasks(); focusComposer(); $('#studioScroll').scrollTop = 0;
}
$('#newTask').onclick = $('#headerNewTask').onclick = newTask;
$('#searchTasks').onclick = () => { location.hash = 'history'; showView(); $('#taskSearch').focus(); };
document.addEventListener('keydown', event => {
  if (event.isComposing || $$('dialog[open]').length) return;
  if (event.key === 'Enter' && !event.shiftKey && document.activeElement === $('#prompt') && !event.isComposing || (event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('#studioView').classList.contains('hidden')) { event.preventDefault(); run(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newTask(); }
  if (event.key === 'Escape' && !$('#configDialog').open) {
    if (document.body.classList.contains('sidebar-mobile-open')) closeSidebar();
    else if (!$('#preferencesPanel').classList.contains('hidden')) togglePreferences(false);
    else if (activeTask(state.viewedTask || {})) { event.preventDefault(); controlTask('pause'); }
  }
  if (event.key === 'Tab' && !$('#configDialog').open) {
    const panel = document.body.classList.contains('sidebar-mobile-open') ? $('#sidebar') : !$('#preferencesPanel').classList.contains('hidden') && matchMedia('(max-width: 980px)').matches ? $('#preferencesPanel') : null;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)')].filter(item => item.getClientRects().length);
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
function safeUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
function displayResult(task) {
  state.resultTaskId = task.id;
  $('#refreshOutputs').disabled = refreshingOutputs.has(task.id);
  $('#refreshOutputs').classList.toggle('hidden', task.demo || !task.sessionId || !['completed', 'failed'].includes(task.status));
  state.resultText = cleanAgentText(task.result) || '任务已结束，暂未收到文本回复。可查看下方注册产物。';
  $('#resultContent').textContent = state.resultText;
  $('#resultNotice').classList.toggle('hidden', !task.demo);
  $('#outputFiles').replaceChildren();
  let outputCount = 0;
  let videoCount = 0;
  for (const file of task.files || []) {
    const url = safeUrl(file.download_url);
    if (!url) continue;
    const card = document.createElement('div'); card.className = 'output-card';
    const kind = file.mime_type?.split('/')[0];
    if (['image', 'video', 'audio'].includes(kind)) {
      const media = document.createElement(kind === 'image' ? 'img' : kind);
      media.src = url;
      if (kind === 'image') { media.alt = file.filename || '创作产物'; media.loading = 'lazy'; }
      else { media.controls = true; media.preload = 'metadata'; if (kind === 'video') { media.playsInline = true; videoCount++; card.classList.add('video-output'); } }
      card.append(media);
    }
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${file.filename || '下载产物'} ↗`; card.append(link); $('#outputFiles').append(card);
    outputCount++;
  }
  $('#outputHeading').textContent = videoCount ? `生成视频 · ${videoCount} 段` : `生成文件 · ${outputCount} 份`;
  $('#outputHeading').classList.toggle('hidden', outputCount === 0);
  $('#result').classList.remove('hidden');
}
function displayProgress(task) {
  const done = task.status === 'completed'; const failed = task.status === 'failed';
  const busy = activeTask(task);
  const problem = ['failed', 'terminated'].includes(task.status) || task.status === 'interrupted' && task.connection !== 'connected';
  $('#progress').classList.toggle('is-complete', done);
  $('#progress').classList.toggle('is-active', busy);
  $('#progress').classList.toggle('has-problem', problem);
  $('#taskSpinner').classList.toggle('finished', done); $('#taskSpinner').classList.toggle('failed', failed);
  $('#statusText').textContent = failed ? '任务未完成' : done ? '创作已完成' : task.status === 'queued' ? '任务排队中 · 可继续新建' : task.demo ? '正在准备演示方案' : 'Agent 正在创作';
  $('#taskMode').textContent = task.demo ? 'DEMO · 不调用模型' : 'SEEDANCE MANAGED AGENT';
  if (!['queued', 'running', 'completed', 'failed'].includes(task.status)) $('#statusText').textContent = taskStateLabel(task);
  $('#progressDetail').textContent = task.error || task.detail || '正在连接创作引擎…';
  const events = task.events || [];
  const sent = task.messages?.some(item => item.role === 'user' && item.delivery === 'sent');
  const connected = task.connection === 'connected' || sent || events.some(item => item.type === 'session.connected');
  const executing = sent || task.executionSteps?.length || task.streamingText;
  const stage = done ? 4 : task.collectingOutputs ? 3 : executing || connected ? 2 : task.sessionId ? 1 : 0;
  const stages = task.demo ? ['保存需求', '整理参数', '演示方案', '演示完成'] : ['准备会话', '连接事件流', 'Agent 执行', '整理产物'];
  $('#executionStages').innerHTML = stages.map((label, index) => `<li class="${index < stage ? 'stage-done' : index === stage ? problem ? 'stage-error' : busy ? 'stage-current' : 'stage-held' : ''}"${index === stage ? ' aria-current="step"' : ''}><span>${index < stage ? '✓' : String(index + 1).padStart(2, '0')}</span>${label}</li>`).join('');
  const connectionLabel = task.demo ? '本机演示' : { connecting: '正在连接', connected: '事件流已连接', reconnecting: '正在恢复连接', disconnected: '连接已断开' }[task.connection] || '等待连接';
  $('#executionConnection').textContent = task.demo ? connectionLabel : !busy && connected && !problem ? '会话记录已同步' : connectionLabel;
  $('#executionConnection').className = `connection-state ${problem ? 'connection-error' : task.connection === 'reconnecting' || task.connection === 'connecting' ? '' : connected ? 'connection-ok' : ''}`;
  const tools = task.executionSteps?.length ? task.executionSteps.filter(item => item.kind === 'tool') : task.toolCalls || [];
  $('#executionCounts').textContent = tools.length ? `工具 ${tools.filter(item => item.status === 'completed').length} / ${tools.length} 已完成` : task.demo ? '演示数据' : task.executionSteps?.length ? `${task.executionSteps.length} 条执行记录` : '等待执行事件';
  $('#executionUsage').textContent = task.usage ? `累计 ${usageTotal(task.usage).toLocaleString()} tokens` : '';
  $('#executionUsage').title = task.usage ? `输入 ${task.usage.input_tokens || 0} · 输出 ${task.usage.output_tokens || 0} · 平台累计用量快照` : '';
  $('#executionSession').textContent = task.sessionId ? `Session · ${task.sessionId}` : task.demo ? '本机预置演示方案' : '云端会话尚未创建';
  $('#executionEventCount').textContent = events.length ? `${events.length} 条` : '';
  $('#eventLog').innerHTML = [...events].reverse().map(event => `<li class="${['task.error', 'session.error'].includes(event.type) ? 'event-error' : ''}"><time datetime="${escapeHtml(event.at || '')}">${executionTime(event.at)}</time><div><b>${escapeHtml(event.label || event.type)}</b>${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ''}</div></li>`).join('') || '<li><div><b>等待会话状态更新</b></div></li>';
  const diagnostics = $('#executionDiagnostics');
  if (diagnostics.dataset.task !== task.id) {
    diagnostics.dataset.task = task.id || '';
    diagnostics.open = problem && !task.executionSteps?.length;
  }
}
function displayTask(task) {
  if (state.activeTaskId !== task.id) return;
  const previous = state.viewedTask;
  if (previous?.id === task.id && (previous.revision || 0) > (task.revision || 0)) return;
  if (previous?.id === task.id && previous.revision === task.revision && previous.updatedAt === task.updatedAt && previous.status === task.status && previous.result === task.result && previous.detail === task.detail) return;
  state.viewedTask = task;
  beginConversation(task.prompt, task.id); displayProgress(task); renderConversation(task);
  if (!$('#studioView').classList.contains('hidden')) { $('#pageTitle').textContent = taskName(task); $('#pageTitle').title = taskName(task); }
  $('#agentMode').value = task.mode || 'agent';
  if (terminalStatus(task.status) && (task.result || task.files?.length)) displayResult(task);
  else { state.resultTaskId = null; $('#result').classList.add('hidden'); }
}
function rememberTask(task) {
  if (task.requestId) localMessages.delete(task.requestId);
  for (const message of task.messages || []) if (message.requestId) localMessages.delete(message.requestId);
  const index = state.tasks.findIndex(item => item.id === task.id);
  if (index < 0) state.tasks.unshift(task);
  else if ((state.tasks[index].revision || 0) <= (task.revision || 0)) state.tasks[index] = task;
  renderHistory();
}
function updateComposerActions() {
  const task = state.viewedTask;
  const busy = task && activeTask(task);
  const hasText = Boolean($('#prompt').value.trim());
  const blocked = messageBlockReason(task);
  const recover = needsRecovery(task);
  $('#runBtn').disabled = state.submitting || controlBusy || state.composerQueue.length > 0 || Boolean(blocked);
  $('#newTask').disabled = state.composerUploading; $('#headerNewTask').disabled = state.composerUploading;
  const label = state.submitting ? '正在发送…' : state.composerQueue.length ? '请先处理参考素材' : blocked || (recover ? '恢复会话并发送' : busy ? followupSetting() === 'steer' ? '立即引导' : '排队发送' : '发送消息');
  $('#runBtn').firstElementChild.textContent = label; $('#runBtn').setAttribute('aria-label', label); $('#runBtn').title = label;
  $('#runBtn').classList.toggle('running', state.submitting);
  $('#pauseBtn').classList.toggle('hidden', !busy); $('#pauseBtn').disabled = controlBusy || task?.status === 'pausing';
  $('#polish').classList.toggle('hidden', Boolean(busy));
  $('#prompt').placeholder = busy ? '补充指令，继续引导当前任务…' : state.activeTaskId ? '继续这段会话，或输入 / 查看命令…' : '向 Seedance 描述任务，或输入 / 查看命令…';
  $('#composerStatus').textContent = state.submitting ? task?.recoveryPending || task?.status === 'recovering' ? '正在恢复原会话，草稿已保留…' : '正在保存并发送消息…' : blocked || (recover ? '发送时将先恢复原会话并核实状态，草稿会保留。' : busy ? `${followupSetting() === 'steer' ? '补充指令将交给当前云端会话' : '补充指令将在当前轮次结束后发送'} · Esc 暂停` : hasText ? 'Enter 发送 · Shift + Enter 换行' : state.activePrompt ? '会话上下文已保留，可以继续。' : '一个想法，就是一个新的开始。');
  let notice = $('#composerRecovery');
  if (!notice) {
    notice = document.createElement('div'); notice.id = 'composerRecovery'; notice.className = 'composer-recovery hidden'; notice.setAttribute('role', 'status');
    notice.append(document.createElement('span'), document.createElement('button'));
    $('.composer-dock').prepend(notice);
  }
  notice.classList.toggle('hidden', !blocked && !recover);
  notice.firstElementChild.textContent = blocked || '连接已中断，发送时会先恢复原会话并核实状态。';
  const action = notice.lastElementChild;
  action.className = 'text-button';
  const unsent = task?.status === 'interrupted' && task.connection === 'connected' && task.stopReason === 'message_not_sent';
  action.textContent = unsent ? '继续执行已保存消息 ↗' : recover ? '恢复会话 ↗' : task?.status === 'terminated' ? '新建会话 ↗' : task?.status === 'waiting' ? '查看工具确认 ↗' : '查看会话状态 ↗';
  action.disabled = state.submitting || controlBusy;
  action.onclick = () => unsent ? controlTask('resume') : recover ? controlTask('recover') : task?.status === 'terminated' ? newTask() : revealMessageBlock(task);
}
function revealMessageBlock(task) {
  const panel = task?.status === 'waiting' ? $('#approvalPanel') : $('#recoveryPanel');
  if (!panel.classList.contains('hidden')) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    panel.querySelector('button')?.focus({ preventScroll: true });
  }
}
async function prepareMessageTask(id, version) {
  let { task } = await api(`/api/tasks/${encodeURIComponent(id)}`);
  const show = () => { rememberTask(task); if (version === taskViewVersion) displayTask(task); };
  show();
  if (version !== taskViewVersion) return null;
  if (needsRecovery(task)) {
    ({ task } = await taskAction('recover', {}, id));
    show();
  }
  const deadline = Date.now() + 90000;
  while (task.recoveryPending || task.status === 'recovering') {
    if (version !== taskViewVersion) return null;
    if (Date.now() >= deadline) throw new Error('原会话仍在恢复，当前草稿已保留，请稍后再发送');
    await new Promise(resolve => setTimeout(resolve, 300));
    if (version !== taskViewVersion) return null;
    ({ task } = await api(`/api/tasks/${encodeURIComponent(id)}`));
    show();
  }
  if (version !== taskViewVersion) return null;
  const blocked = messageBlockReason(task);
  if (blocked) { revealMessageBlock(task); throw new Error(blocked); }
  if (needsRecovery(task)) throw new Error(`${task.error || '原会话恢复失败'} 当前草稿已保留，请检查连接后重试。`);
  return task;
}
async function run() {
  if (state.submitting || controlBusy) return;
  if (state.composerQueue.length) return toast('请先等待上传完成，或处理失败素材', true);
  const prompt = $('#prompt').value.trim();
  if (!prompt) { if (activeTask(state.viewedTask || {})) return controlTask('pause'); $('#prompt').focus(); return; }
  if (await handleCommand(prompt)) return;
  const id = state.activeTaskId;
  const blocked = messageBlockReason(state.viewedTask);
  if (blocked) { revealMessageBlock(state.viewedTask); return toast(blocked, true); }
  const version = ++taskViewVersion;
  const settings = options(); const assetIds = [...state.selected];
  const mode = $('#agentMode').value; const delivery = followupSetting();
  const signature = JSON.stringify({ id, prompt, settings, assetIds, mode, delivery });
  if (pendingSubmission?.signature !== signature) pendingSubmission = { signature, requestId: crypto.randomUUID() };
  const requestId = pendingSubmission.requestId;
  storeDraft();
  state.submitting = true; updateComposerActions();
  const previewTask = id && state.viewedTask || { id, prompt: state.activePrompt || prompt, status: 'queued', demo: !state.config.configured, messages: [] };
  const previousMessage = localMessages.get(requestId);
  const timelineOrder = Math.max(previewTask?.timelineSequence || 0, ...[...(previewTask?.messages || []), ...(previewTask?.executionSteps || []), ...(previewTask?.toolCalls || []), ...(previewTask?.streamingPreviews || []), ...[...localMessages.values()].filter(item => item.taskId === id)].map(item => item.timelineOrder || 0)) + 1;
  localMessages.set(requestId, { id: `local-${requestId}`, requestId, taskId: id, role: 'user', text: prompt, assetIds, createdAt: previousMessage?.createdAt || new Date().toISOString(), timelineOrder: previousMessage?.timelineOrder || timelineOrder, delivery: 'sending' });
  if (!id) {
    state.viewedTask = null; state.resultTaskId = null;
    beginConversation(prompt); $('#result').classList.add('hidden');
    displayProgress({ status: 'queued', demo: !state.config.configured, detail: '正在保存消息…' });
  }
  renderConversation(previewTask, { revealRequestId: requestId });
  try {
    if (id && !await prepareMessageTask(id, version)) { localMessages.delete(requestId); return; }
    const { task } = await api(id ? `/api/tasks/${encodeURIComponent(id)}/messages` : '/api/creative', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, options: settings, assetIds, requestId, mode, delivery }) });
    if (pendingSubmission?.requestId === requestId) pendingSubmission = null;
    if (version === taskViewVersion) {
      if ($('#prompt').value.trim() === prompt) { $('#prompt').value = ''; state.selected.clear(); storeDraft(); }
      if (!id) { switchDraft(task.id); $('#prompt').value = ''; state.selected.clear(); }
      if (!id) { state.activeTaskId = task.id; state.viewedTask = null; }
      renderAttachments(); updateCount(); displayTask(task); $('#prompt').focus({ preventScroll: true });
    }
    rememberTask(task);
  } catch (error) {
    const message = localMessages.get(requestId);
    if (message) message.delivery = 'local_failed';
    if (version === taskViewVersion) renderConversation(state.viewedTask || previewTask);
    if (!id && version === taskViewVersion) displayProgress({ status: 'failed', demo: !state.config.configured, error: `${error.message}。草稿已保留，重试将使用相同请求标识。` });
    toast(error.message, true);
  } finally { state.submitting = false; updateComposerActions(); refreshHistory().catch(() => {}); }
}
$('#runBtn').onclick = run;
$('#copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(state.resultText); toast('方案已复制'); } catch { toast('复制失败，请选中结果文本手动复制', true); } };
$('#refreshOutputs').onclick = async () => {
  const taskId = state.resultTaskId;
  if (!taskId || refreshingOutputs.has(taskId)) return;
  refreshingOutputs.add(taskId);
  $('#refreshOutputs').disabled = true;
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(taskId)}/refresh-outputs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    rememberTask(task); displayTask(task);
    if (state.activeTaskId === taskId) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(task.files?.length ? `已找回 ${task.files.length} 份创作产物；未重复调用生成` : '产物链接已刷新；未重复调用生成');
  }
  catch (error) { toast(error.message, true); }
  finally { refreshingOutputs.delete(taskId); if (state.resultTaskId === taskId) $('#refreshOutputs').disabled = false; }
};
$('#downloadBtn').onclick = () => {
  const url = URL.createObjectURL(new Blob([state.resultText], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `visionary-${new Date().toISOString().slice(0, 10)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function renderAttachments() {
  const selected = [...state.selected].map(id => state.assets.find(item => item.id === id)).filter(Boolean).map(item => ({ item }));
  const queued = state.composerQueue.map(upload => ({ item: upload.file, upload }));
  $('#attachments').replaceChildren(...[...selected, ...queued].map(({ item, upload }) => {
    const card = document.createElement('div'); card.className = `attachment${upload ? upload.status === 'failed' ? ' failed' : ' pending' : ''}`; card.setAttribute('role', 'listitem');
    if (!upload && item.type?.startsWith('image/') && item.hasLocalFile) {
      const image = document.createElement('img'); image.className = 'attachment-thumbnail'; image.src = `/api/assets/${encodeURIComponent(item.id)}/content`; image.alt = ''; card.append(image);
    } else {
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = fileIcon(item.type); icon.setAttribute('aria-hidden', 'true'); card.append(icon);
    }
    const info = document.createElement('div'); info.className = 'attachment-info';
    const name = document.createElement('b'); name.textContent = item.name; name.title = item.name;
    const status = document.createElement('small'); status.className = 'attachment-status';
    status.textContent = upload ? upload.status === 'failed' ? `${upload.localAssetId ? '本机已保存 · 方舟同步失败' : '上传失败'} · ${upload.error}` : upload.progress || '等待上传…' : `${item.size ? `${formatSize(item.size)} · ` : ''}已添加参考`;
    status.title = status.textContent;
    if (upload) status.dataset.uploadId = upload.id;
    info.append(name, status); card.append(info);
    if (upload?.status === 'failed') {
      const retry = document.createElement('button'); retry.className = 'attachment-retry'; retry.textContent = upload.localAssetId ? '重试同步' : '重试'; retry.setAttribute('aria-label', `${upload.localAssetId ? '重试同步' : '重新上传'} ${item.name}`);
      retry.onclick = () => upload.localAssetId ? retryComposerSync(upload) : (() => { upload.status = 'queued'; upload.error = ''; upload.progress = ''; renderAttachments(); processComposerUploads(); })(); card.append(retry);
    }
    const remove = document.createElement('button'); remove.className = 'attachment-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除参考 ${item.name}`); remove.disabled = upload?.status === 'uploading';
    remove.onclick = () => {
      if (upload) state.composerQueue = state.composerQueue.filter(entry => entry !== upload);
      else state.selected.delete(item.id);
      renderAttachments(); renderAssets();
    };
    card.append(remove); return card;
  }));
  storeDraft();
  const count = state.selected.size + state.composerQueue.length;
  $('#attachmentCount').textContent = count ? `(${count})` : '';
  updateComposerActions();
}
const clipboardMediaExtensions = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg'
};
function addComposerFiles(files) {
  for (let file of files) {
    if (!file.size || file.size > 512 * 1024 * 1024) { toast(`文件需大于 0 且不超过 512 MB：${file.name || '参考素材'}`, true); continue; }
    if (!/\.(jpe?g|png|webp|gif|tiff?|heic|heif|mp4|mov|webm|mp3|wav|m4a|aac|ogg)$/i.test(file.name)) {
      const extension = clipboardMediaExtensions[file.type.toLowerCase()];
      if (!extension) { toast(`暂不支持此文件格式：${file.name || file.type || '未知文件'}，请使用常用图片、视频或音频格式`, true); continue; }
      file = new File([file], `粘贴素材-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`, { type: file.type, lastModified: file.lastModified });
    }
    if (!state.composerQueue.some(entry => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified)) {
      state.composerQueue.push({ id: crypto.randomUUID(), file, status: 'queued' });
    }
  }
  renderAttachments(); processComposerUploads();
}
async function processComposerUploads() {
  if (state.composerUploading || !state.composerQueue.some(item => item.status === 'queued')) return;
  state.composerUploading = true;
  try {
    let upload;
    while ((upload = state.composerQueue.find(item => item.status === 'queued'))) {
      upload.status = 'uploading'; upload.progress = '正在上传…'; renderAttachments();
      try {
        // Upload references through Files; the Agent enrolls portrait references
        // before generation and preserves their order beside ordinary scenes.
        const item = await uploadFile(upload.file, { collection: 'reference', onProgress: message => {
          upload.progress = message;
          const status = $(`[data-upload-id="${upload.id}"]`);
          if (status) { status.textContent = message; status.title = message; }
        } });
        state.assets = [item, ...state.assets.filter(asset => asset.id !== item.id)];
        upload.localAssetId = item.id;
        if (!item.arkFileId || item.error) throw new Error(item.error || '已本机保存，需配置 API Key 后重试同步');
        state.selected.add(item.id);
        state.composerQueue = state.composerQueue.filter(entry => entry !== upload);
      } catch (error) {
        upload.status = 'failed'; upload.error = error.message;
        toast(`${upload.file.name}：${error.message}`, true);
      }
      renderAssets(); renderAttachments();
    }
  } finally { state.composerUploading = false; renderAttachments(); }
}
async function retryComposerSync(upload) {
  upload.status = 'uploading'; upload.error = ''; upload.progress = '正在同步到方舟…'; renderAttachments();
  try {
    const { item } = await api(`/api/assets/${encodeURIComponent(upload.localAssetId)}/sync`, { method: 'POST' });
    state.assets = [item, ...state.assets.filter(asset => asset.id !== item.id)];
    state.selected.add(item.id);
    state.composerQueue = state.composerQueue.filter(entry => entry !== upload);
  } catch (error) {
    upload.status = 'failed'; upload.error = error.message;
    toast(`${upload.file.name}：${error.message}`, true);
  }
  renderAssets(); renderAttachments();
}
$('#composer').addEventListener('click', event => {
  if (!event.target.closest('button, textarea, input, select, a') && !window.getSelection()?.toString()) $('#composer').focus({ preventScroll: true });
});
$('#composer').addEventListener('paste', event => {
  const data = event.clipboardData;
  if (!data) return;
  const message = copiedMessage(data);
  if (message) {
    event.preventDefault();
    pasteMessage(message).catch(() => toast('粘贴引用素材失败，请从素材库重新选择', true));
    return;
  }
  // Read file handles synchronously; browsers may clear clipboardData after the event.
  const files = data.files?.length ? [...data.files] : [...(data.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault(); addComposerFiles(files);
});
let composerDragDepth = 0;
const isFileDrag = event => [...(event.dataTransfer?.types || [])].includes('Files');
function resetComposerDrag() {
  composerDragDepth = 0;
  $('#composer').classList.remove('dragging');
}
$('#composer').addEventListener('dragenter', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault(); composerDragDepth++;
  $('#composer').classList.add('dragging');
});
$('#composer').addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
$('#composer').addEventListener('dragleave', () => {
  composerDragDepth = Math.max(0, composerDragDepth - 1);
  if (!composerDragDepth) resetComposerDrag();
});
$('#composer').addEventListener('drop', event => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault(); resetComposerDrag(); addComposerFiles(files);
});
// Prevent files dropped outside an upload area from navigating away from the draft.
document.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  if (!event.defaultPrevented) event.dataTransfer.dropEffect = 'none';
  event.preventDefault();
});
document.addEventListener('drop', event => {
  if (isFileDrag(event)) event.preventDefault();
  resetComposerDrag();
});
document.addEventListener('dragend', resetComposerDrag);
window.addEventListener('blur', resetComposerDrag);
$('#directUploadButton').onclick = () => $('#composerFileInput').click();
$('#composerFileInput').onchange = () => { addComposerFiles($('#composerFileInput').files); $('#composerFileInput').value = ''; };
$('#attachButton').onclick = () => { location.hash = 'assets'; selectCollection('reference'); toast('选择已同步的参考素材，然后返回工作台'); };
function renderQueue() {
  $('#selectedFiles').innerHTML = state.queue.map((file, index) => `<div class="queued-file"><span class="file-icon">${fileIcon(file.type)}</span><div><b>${escapeHtml(file.name)}</b><small>${formatSize(file.size)}</small></div><button data-remove="${index}" aria-label="移除文件" ${state.uploading ? 'disabled' : ''}>×</button></div>`).join('');
  $$('[data-remove]').forEach(button => button.onclick = () => { state.queue.splice(Number(button.dataset.remove), 1); renderQueue(); });
  $('#uploadAction').disabled = state.uploading || !state.queue.length;
  if (!state.uploading) $('#uploadAction').textContent = state.queue.length ? `上传 ${state.queue.length} 个文件 ↗` : '上传到素材库 ↗';
}
function addFiles(files) {
  if (state.uploading) return toast('请等待本批文件上传完成', true);
  for (const file of files) {
    if (!file.size || file.size > 512 * 1024 * 1024) { toast(`文件需大于 0 且不超过 512 MB：${file.name}`, true); continue; }
    if (state.collection === 'private-person' && !/^(image|video)\//.test(file.type)) { toast('真人素材分类仅支持图片和视频', true); continue; }
    if (state.collection === 'virtual-avatar' && !/^(image|video|audio)\//.test(file.type) && !/\.(jpe?g|png|webp|gif|tiff?|heic|heif|mp4|mov|webm|mp3|wav|m4a|aac|ogg)$/i.test(file.name)) { toast('虚拟素材库支持图片、视频、音频，文档请放到参考素材', true); continue; }
    if (state.collection === 'virtual-avatar' && (/^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|tiff?|heic|heif)$/i.test(file.name)) && file.size >= 30 * 1024 * 1024) { toast('虚拟人像图片需小于 30 MB', true); continue; }
    if (!state.queue.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) state.queue.push(file);
  }
  renderQueue();
}
$('#fileInput').onchange = () => { addFiles($('#fileInput').files); $('#fileInput').value = ''; };
['dragenter', 'dragover'].forEach(name => $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); }));
$('#dropzone').addEventListener('drop', event => addFiles(event.dataTransfer.files));
function selectCollection(collection) {
  if (state.uploading) return toast('上传中，暂时不能切换分类', true);
  if (state.collection !== collection && state.queue.length) { state.queue = []; renderQueue(); toast('已切换分类，请重新添加文件'); }
  state.collection = collection;
  $$('.upload-tab').forEach(button => { const selected = button.dataset.collection === collection; button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); });
  $('#localUpload').classList.remove('hidden'); $('#avatarUpload').classList.toggle('hidden', collection !== 'virtual-avatar');
  const privatePerson = collection === 'private-person';
  $('#portraitPanel').classList.toggle('hidden', !privatePerson);
  $('#uploadTitle').textContent = privatePerson ? '上传本人授权的图片 / 视频' : '给创作一点参考';
  $('#uploadHint').textContent = privatePerson ? '此处保留旧版真人认证素材接口。当前人像创作统一通过 AIGC 素材库提交审核。' : '上传剧本、图片、视频或音频。同步成功的参考文件可挂载到 Agent 会话；人像会先提交 AIGC 库审核。';
  $('#uploadPrivacy').textContent = privatePerson ? '本机暂存 ≠ 云端入库，审核 Active 后才可使用' : '参考素材通过服务端同步方舟 Files API';
  $('#dropzone small').textContent = privatePerson ? '仅图片 / 视频 · 单个文件最大 512 MB · 入库前需本人认证' : 'PDF / DOCX / TXT / 图片 / 视频 / 音频 · 单个文件最大 512 MB';
  $('#fileInput').accept = privatePerson ? 'image/*,video/*' : collection === 'virtual-avatar' ? '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.ogg' : '.pdf,.doc,.docx,.txt,.md,image/*,video/*,audio/*';
  if (collection === 'virtual-avatar') {
    $('#uploadTitle').textContent = '上传角色的画面与声音';
    $('#uploadHint').textContent = '真人与虚拟角色统一提交至所选 AIGC 素材组。支持图片、视频和音频，审核通过后才能生成。';
    $('#uploadPrivacy').textContent = 'Files 临时托管 → 私域素材库审核 → Active 可引用';
    $('#dropzone small').textContent = '图片 < 30 MB · 视频 / 音频 ≤ 512 MB';
    $('#fileInput').accept = '.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.heic,.heif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.ogg';
  } else if (collection === 'reference') $('#uploadHint').textContent = '上传参考剧本、文档、图片、视频或音频，同步成功后可挂载到 Agent 会话。人物素材生成前统一提交 AIGC 库审核。';
  renderAssets();
}
$$('.upload-tab').forEach(button => button.onclick = () => selectCollection(button.dataset.collection));
function renderAssets() {
  const query = $('#assetSearch').value.toLowerCase();
  const items = state.assets.filter(item => item.collection === state.collection && item.name.toLowerCase().includes(query));
  $('#assetCount').textContent = state.assets.length; $('#libraryCount').textContent = state.assets.length; $('#filteredAssetCount').textContent = items.length;
  if (!items.length) { $('#assetList').innerHTML = `<div class="empty-state"><span>▧</span><b>${query ? '没有匹配的素材' : '给灵感，留一个位置'}</b><p>${query ? '试试其他关键词' : '上传第一份素材，从这里积累下一次创作'}</p></div>`; return; }
  $('#assetList').innerHTML = items.map(item => {
    const contentUrl = `/api/assets/${encodeURIComponent(item.id)}/content`;
    const selectable = selectableAsset(item);
    const canEnroll = ['private-person', 'virtual-avatar'].includes(item.collection) && item.hasLocalFile && !item.assetId && !['uploading', 'submitting', 'unknown'].includes(item.enrollmentState);
    const canSync = item.collection === 'reference' && item.hasLocalFile && !item.arkFileId;
    const thumbnail = item.type?.startsWith('image/') && item.hasLocalFile ? `<img class="asset-thumbnail" src="${contentUrl}" alt="" loading="lazy">` : `<span class="file-icon">${fileIcon(item.type)}</span>`;
    return `<div class="asset-row">${thumbnail}<div class="asset-info"><b title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</b><small>${item.size ? formatSize(item.size) + ' · ' : ''}${dateLabel(item.createdAt)}${item.arkFileId ? ' · Files 已同步' : ''}${item.assetId ? ` · ${escapeHtml(item.assetId)}` : ''}</small></div><span class="asset-status ${item.error ? 'failed' : ''}" title="${escapeHtml(item.error || '')}">${escapeHtml(item.status)}${item.error ? `<small class="asset-error-detail">${escapeHtml(item.error)}</small>` : ''}</span>${canSync ? `<button class="asset-select" data-sync="${item.id}">同步到方舟 ↗</button>` : ''}${canEnroll ? `<button class="asset-select" data-enroll="${item.id}">提交入库 ↗</button>` : ''}${selectable ? `<button class="asset-select ${state.selected.has(item.id) ? 'selected' : ''}" data-select="${item.id}">${state.selected.has(item.id) ? '✓ 已选' : '＋ 引用'}</button>` : ''}${item.hasLocalFile ? `<a class="asset-preview" href="${contentUrl}" target="_blank" rel="noopener noreferrer" aria-label="预览 ${escapeHtml(item.name)}">↗</a>` : ''}<button class="asset-delete" data-delete="${item.id}" aria-label="删除本机记录 ${escapeHtml(item.name)}">×</button></div>`;
  }).join('');
  $$('[data-select]').forEach(button => button.onclick = () => { const id = button.dataset.select; if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); renderAssets(); renderAttachments(); toast(state.selected.size ? `已选择 ${state.selected.size} 份参考，可返回工作台创作` : '已取消引用'); });
  $$('[data-sync]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    try {
      await api(`/api/assets/${encodeURIComponent(button.dataset.sync)}/sync`, { method: 'POST' });
      await refreshAssets(); toast('参考素材已同步到方舟，可用于创作');
    } catch (error) { toast(error.message, true); button.disabled = false; }
  });
  $$('[data-enroll]').forEach(button => button.onclick = async () => {
    const item = state.assets.find(asset => asset.id === button.dataset.enroll);
    if (item.collection === 'virtual-avatar') {
      if (!$('#virtualConsent').checked) return toast('请先确认素材使用权限与上传同意', true);
      button.disabled = true;
      try { await enrollVirtualAsset(item.id); await refreshAssets(); toast('已提交虚拟素材入库，等待方舟审核'); }
      catch (error) { toast(error.message, true); button.disabled = false; }
      return;
    }
    const verificationId = $('#portraitGroup').value;
    if (!verificationId) return toast('请先完成本人认证，并选择对应的真人素材组', true);
    if (!confirm(`确认「${item.name}」与所选认证人为同一人，并同意上传至方舟 Files API 临时托管及真人素材库审核？`)) return;
    button.disabled = true;
    try { await enrollAsset(item.id, verificationId); await refreshAssets(); toast('已开始入库，审核状态会自动更新'); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
  $$('[data-delete]').forEach(button => button.onclick = async () => {
    const item = state.assets.find(asset => asset.id === button.dataset.delete);
    if (!confirm(`删除本机素材「${item.name}」？不会删除已上传方舟的云端文件。`)) return;
    try { await api(`/api/assets/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); state.selected.delete(item.id); await refreshAssets(); toast('本机素材已删除'); } catch (error) { toast(error.message, true); }
  });
}
async function refreshAssets() {
  const version = ++assetRefreshVersion;
  const knownIds = new Set(state.assets.map(item => item.id));
  const { items } = await api('/api/assets');
  if (version !== assetRefreshVersion) return;
  const fetchedIds = new Set(items.map(item => item.id));
  // Keep uploads completed after this list request started.
  state.assets = [...state.assets.filter(item => !knownIds.has(item.id) && !fetchedIds.has(item.id)), ...items];
  state.selected.forEach(id => { if (!state.assets.some(item => item.id === id && selectableAsset(item))) state.selected.delete(id); });
  renderAssets(); renderAttachments();
  clearTimeout(assetPollTimer);
  if (state.viewedTask) renderConversation(state.viewedTask);
  if (state.assets.some(item => item.remoteStatus === 'Processing' || ['uploading', 'submitting'].includes(item.enrollmentState))) assetPollTimer = setTimeout(() => refreshAssets().catch(error => toast(error.message, true)), 7000);
}
$('#assetSearch').oninput = renderAssets;
$('#refreshAssets').onclick = () => refreshAssets().then(() => toast('素材列表已更新')).catch(error => toast(error.message, true));
async function enrollAsset(id, verificationId) {
  return api(`/api/assets/${encodeURIComponent(id)}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verificationId, consent: true }) });
}
const virtualDestination = () => ({ consent: $('#virtualConsent').checked, ...($('#avatarGroup').value ? { groupId: $('#avatarGroup').value } : {}) });
async function enrollVirtualAsset(id) {
  return api(`/api/assets/${encodeURIComponent(id)}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(virtualDestination()) });
}
async function refreshAvatarGroups() {
  if (!state.config.avatarLibraryConfigured) { $('#avatarGroupStatus').textContent = '请在服务端配置 AK/SK 后连接虚拟素材库。'; return; }
  const selected = $('#avatarGroup').value;
  const groups = [];
  const seen = new Set();
  let nextToken;
  do {
    const result = await api(`/api/avatar-groups${nextToken ? `?${new URLSearchParams({ nextToken })}` : ''}`);
    groups.push(...result.items);
    nextToken = result.nextToken;
    if (nextToken && seen.has(nextToken)) throw new Error('素材组分页重复，请稍后刷新');
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  state.avatarGroups = groups;
  $('#avatarGroup').replaceChildren(new Option('自动创建 / 复用默认素材组', ''), ...groups.map(group => new Option(`${group.name} · ${group.id}`, group.id)));
  if (groups.some(group => group.id === selected)) $('#avatarGroup').value = selected;
  else if (groups.length === 1) $('#avatarGroup').value = groups[0].id;
  $('#avatarGroupStatus').textContent = `已连接 ${state.config.project} · ${groups.length} 个 AIGC 虚拟素材组`;
}
$('#refreshAvatarGroups').onclick = () => refreshAvatarGroups().catch(error => { $('#avatarGroupStatus').textContent = error.message; toast(error.message, true); });
$('#avatarGroupForm').onsubmit = async event => {
  event.preventDefault(); $('#createAvatarGroup').disabled = true;
  try {
    const { group } = await api('/api/avatar-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: new FormData(event.currentTarget).get('name').trim() }) });
    await refreshAvatarGroups(); $('#avatarGroup').value = group.id; event.target.reset(); toast('虚拟素材组已创建');
  } catch (error) { $('#avatarGroupStatus').textContent = error.message; toast(error.message, true); }
  finally { $('#createAvatarGroup').disabled = false; }
};
$('#syncAvatarAssets').onclick = async () => {
  const groupId = $('#avatarGroup').value;
  if (!groupId) return toast('请先选择需要同步的虚拟素材组', true);
  $('#syncAvatarAssets').disabled = true;
  try {
    let nextToken;
    let count = 0;
    const seen = new Set();
    do {
      const result = await api('/api/avatar-assets/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId, ...(nextToken ? { nextToken } : {}) }) });
      count += result.count; nextToken = result.nextToken;
      if (nextToken && seen.has(nextToken)) throw new Error('素材分页重复，请稍后刷新');
      if (nextToken) seen.add(nextToken);
    } while (nextToken);
    await refreshAssets(); toast(`已同步 ${count} 份云端虚拟素材`);
  } catch (error) { toast(error.message, true); }
  finally { $('#syncAvatarAssets').disabled = false; }
};
function renderVerifications() {
  const selected = $('#portraitGroup').value;
  const verified = state.verifications.filter(item => item.status === 'verified' && item.groupId);
  $('#portraitGroup').replaceChildren(new Option(verified.length ? '请选择对应的同人素材组' : '先完成本人认证并查询结果', ''), ...verified.map(item => new Option(`${item.name} · ${item.groupId}`, item.id)));
  if (verified.some(item => item.id === selected)) $('#portraitGroup').value = selected;
  else if (verified.length === 1) $('#portraitGroup').value = verified[0].id;
  $('#portraitVerifications').replaceChildren(...state.verifications.map(item => {
    const row = document.createElement('div'); row.className = 'verification-row';
    const info = document.createElement('div');
    info.append(Object.assign(document.createElement('b'), { textContent: item.name }), Object.assign(document.createElement('small'), { textContent: item.status === 'verified' ? `✓ ${item.source === 'existing' ? '已有真人组已校验' : '已认证'} · ${item.groupId}` : item.status === 'expired' ? '认证已过期，请重新创建' : `待本人完成认证 · 有效至 ${dateLabel(item.expiresAt)}` }));
    if (item.error) info.append(Object.assign(document.createElement('small'), { className: 'verification-error', textContent: item.error }));
    row.append(info);
    const h5Url = safeUrl(item.h5Url);
    if (h5Url && item.status === 'pending') {
      const link = document.createElement('a'); link.href = h5Url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开本人认证 ↗'; row.append(link);
      const copy = Object.assign(document.createElement('button'), { textContent: '复制链接' });
      copy.onclick = () => navigator.clipboard.writeText(h5Url).then(() => toast('已复制临时认证链接，仅发送给肖像权本人')).catch(() => toast('复制失败，请直接打开认证', true)); row.append(copy);
      const refresh = Object.assign(document.createElement('button'), { textContent: '已完成 · 查询结果' });
      refresh.onclick = async () => {
        refresh.disabled = true;
        try { await api(`/api/portrait-verifications/${encodeURIComponent(item.id)}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refreshVerifications(); toast('真人认证通过，可提交同人素材入库'); }
        catch (error) { toast(error.message, true); refresh.disabled = false; }
      };
      row.append(refresh);
    }
    return row;
  }));
}
async function refreshVerifications() {
  const { items } = await api('/api/portrait-verifications'); state.verifications = items; renderVerifications();
}
$('#portraitVerificationForm').onsubmit = async event => {
  event.preventDefault();
  if (!state.config.avatarLibraryConfigured || !state.config.realPersonCallbackConfigured) { openConfig(); return toast('请先配置 AK/SK 及公网真人认证回调地址', true); }
  const form = new FormData(event.currentTarget); $('#createVerification').disabled = true;
  try {
    const { verification } = await api('/api/portrait-verifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), consent: form.get('consent') === 'on' }) });
    state.verifications.unshift(verification); renderVerifications(); toast('认证链接已创建，请由本人打开完成活体认证');
  } catch (error) { toast(error.message, true); }
  finally { $('#createVerification').disabled = false; }
};
$('#portraitImportForm').onsubmit = async event => {
  event.preventDefault();
  if (!state.config.avatarLibraryConfigured) { openConfig(); return toast('导入已有真人组需要服务端 AK/SK，不需要重复真人认证', true); }
  const form = new FormData(event.currentTarget); $('#importPortraitGroup').disabled = true;
  try {
    const { verification } = await api('/api/portrait-verifications/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: form.get('groupId').trim(), consent: form.get('consent') === 'on' }) });
    await refreshVerifications(); $('#portraitGroup').value = verification.id; toast('已有真人素材组校验通过，可上传同人素材');
  } catch (error) { toast(error.message, true); }
  finally { $('#importPortraitGroup').disabled = false; }
};
function uploadFile(file, { collection = state.collection, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/uploads'); xhr.timeout = 660000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream'); xhr.setRequestHeader('X-Collection', collection);
    xhr.upload.onprogress = event => onProgress(event.lengthComputable && event.loaded < event.total ? `上传中 · ${Math.round(event.loaded / event.total * 100)}%` : `${collection === 'private-person' || !state.config.filesApiConfigured ? '正在本机保存' : '正在同步方舟'}…`);
    xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) throw new Error(data.error || '上传失败'); resolve(data.item); } catch (error) { reject(error); } };
    xhr.onerror = () => reject(new Error('上传连接中断')); xhr.ontimeout = () => reject(new Error('上传超时，可刷新列表确认是否已保存')); xhr.send(file);
  });
}
$('#uploadAction').onclick = async () => {
  if (state.uploading || !state.queue.length) return;
  const virtual = state.collection === 'virtual-avatar';
  const automatic = virtual || state.collection === 'private-person' && $('#autoEnroll').checked;
  const verificationId = $('#portraitGroup').value;
  if (virtual && !$('#virtualConsent').checked) return toast('请先确认素材使用权限与上传同意', true);
  if (automatic && !virtual && !verificationId) return toast('请先完成本人认证并选择对应的素材组', true);
  if (automatic && !state.config.avatarLibraryConfigured) { openConfig(); return toast('素材入库需要 AK/SK，请先配置', true); }
  state.uploading = true; renderQueue(); const pending = [...state.queue]; const failed = []; let syncFailures = 0;
  let enrollmentFailures = 0;
  for (const [index, file] of pending.entries()) {
    try {
      const item = await uploadFile(file, { onProgress: message => { $('#uploadAction').textContent = `${index + 1}/${pending.length} · ${message}`; } }); if (item.error) syncFailures++;
      if (automatic) { try { if (virtual) await enrollVirtualAsset(item.id); else await enrollAsset(item.id, verificationId); } catch (error) { enrollmentFailures++; toast(`${file.name} 入库未开始：${error.message}`, true); } }
    }
    catch (error) { failed.push(file); toast(`${file.name}：${error.message}`, true); }
  }
  state.queue = failed; state.uploading = false; renderQueue();
  try { await refreshAssets(); } catch (error) { toast(error.message, true); }
  if (!failed.length) toast(enrollmentFailures ? `${enrollmentFailures} 份未开始入库，文件已本机保存，请查看状态` : syncFailures ? `已本机保存；${syncFailures} 份未同步方舟，请查看状态` : automatic ? `已保存 ${pending.length} 份素材并开始入库，等待 Active 审核` : `已保存 ${pending.length} 份素材`, Boolean(syncFailures || enrollmentFailures));
};
$('#avatarForm').onsubmit = async event => {
  event.preventDefault();
  if (!state.config.avatarLibraryConfigured) { openConfig(); return toast('方舟资产入库还需要在服务端配置 AK/SK', true); }
  const form = new FormData(event.currentTarget); $('#avatarSubmit').disabled = true; $('#avatarStatus').textContent = '正在提交方舟审核…';
  try {
    const response = await api('/api/avatar-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), assetType: form.get('assetType'), assetUrl: form.get('assetUrl'), ...virtualDestination() }) });
    $('#avatarStatus').textContent = `${response.item.name} 已进入入库队列，可在下方查看审核状态。`; await refreshAssets();
  } catch (error) { $('#avatarStatus').textContent = error.message; toast(error.message, true); }
  finally { $('#avatarSubmit').disabled = false; }
};
function renderRecentTasks() {
  const available = state.tasks.filter(task => !task.archived);
  const items = [...available].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(activeTask(b)) - Number(activeTask(a)) || new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 30);
  $('#recentTasks').innerHTML = items.length ? items.map(task => `<button class="recent-task${state.activeTaskId === task.id ? ' active' : ''}" data-task="${escapeHtml(task.id)}" title="${escapeHtml(taskName(task))} · ${taskStatus[task.status] || task.status}"><span class="recent-task-dot ${escapeHtml(task.status)}"></span><span>${task.pinned ? '⌃ ' : ''}${escapeHtml(taskName(task))}</span></button>`).join('') : '<p class="recent-empty">从一个想法，开始你的创作。</p>';
  $$('#recentTasks [data-task]').forEach(button => button.onclick = () => openTask(button.dataset.task));
}
function renderHistory() {
  const query = $('#taskSearch').value.trim().toLowerCase();
  const items = state.tasks.filter(task => Boolean(task.archived) === $('#showArchived').checked && `${taskName(task)} ${task.prompt}`.toLowerCase().includes(query));
  $('#historyCount').textContent = state.tasks.length; $('#taskTotal').textContent = state.tasks.length;
  $('#historyList').innerHTML = items.length ? items.map(task => `<div class="history-row"><span class="file-icon">✦</span><div><b>${escapeHtml(taskName(task))}</b><small><span class="task-status-dot ${escapeHtml(task.status)}"></span>${dateLabel(task.createdAt)} · ${task.demo ? '演示方案' : 'Seedance Managed Agent'} · ${taskStatus[task.status] || escapeHtml(task.status)}</small></div><button data-manage-task="${escapeHtml(task.id)}" aria-label="管理会话">···</button><button data-task="${escapeHtml(task.id)}">打开 ↗</button></div>`).join('') : `<div class="empty-state"><span>◷</span><b>${query ? '没有匹配的创作' : '你的创作故事，还未开始'}</b><p>${query ? '试试其他关键词' : '提交第一份创作后，就会在这里留下记录'}</p></div>`;
  $$('#historyList [data-task]').forEach(button => button.onclick = () => openTask(button.dataset.task));
  $$('#historyList [data-manage-task]').forEach(button => button.onclick = () => openThreadSettings(button.dataset.manageTask));
  renderRecentTasks(); updateComposerActions();
  const running = state.tasks.filter(task => ['running', 'recovering', 'pausing'].includes(task.status)).length;
  const queued = state.tasks.filter(task => task.status === 'queued').length;
  $('#taskActivity').classList.toggle('hidden', !running && !queued && !state.taskMonitorError);
  $('#taskActivity').classList.toggle('sync-error', state.taskMonitorError);
  $('#taskActivity').textContent = state.taskMonitorError ? '任务状态同步中断，正在自动重试 · 可继续新建创作 ↗' : `${[running ? `${running} 个任务后台生成中` : '', queued ? `${queued} 个任务排队中` : ''].filter(Boolean).join(' · ')} · 可继续新建创作 ↗`;
}
$('#taskSearch').oninput = renderHistory;
async function openTask(id) {
  if (state.composerUploading) return toast('请等待参考素材上传完成', true);
  const version = ++taskViewVersion;
  switchDraft(id); subscribeTask(id);
  state.activeTaskId = id; state.viewedTask = null; state.resultTaskId = null;
  $('#result').classList.add('hidden'); $('#progress').classList.add('hidden');
  const summary = state.tasks.find(task => task.id === id);
  if (summary) beginConversation(summary.prompt, id);
  goStudio();
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}`);
    if (version !== taskViewVersion || state.activeTaskId !== id) return;
    rememberTask(task); displayTask(task);
    $('#conversation').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (version === taskViewVersion) toast(`暂时无法读取任务：${error.message}，稍后自动重试`, true);
  } finally { refreshHistory().catch(() => {}); }
}
async function refreshHistory() {
  if (historyRequest) return historyRequest;
  clearTimeout(historyPollTimer);
  historyRequest = (async () => {
    const knownIds = new Set(state.tasks.map(task => task.id));
    const { items } = await api('/api/tasks');
    const previous = new Map(state.tasks.map(task => [task.id, task]));
    const newlySubmitted = state.tasks.filter(task => !knownIds.has(task.id));
    const newIds = new Set(newlySubmitted.map(task => task.id));
    state.tasks = [...newlySubmitted, ...items.filter(task => !newIds.has(task.id)).map(task => {
      const local = previous.get(task.id);
      return (local?.revision || 0) > (task.revision || 0) ? local : task;
    })];
    const finished = state.tasks.filter(task => previous.has(task.id) && activeTask(previous.get(task.id)) && !activeTask(task));
    if (finished.length) toast(finished.length === 1 ? `「${finished[0].prompt.slice(0, 24)}」${taskStatus[finished[0].status]}，可在历史任务中查看` : `${finished.length} 个后台任务已结束，可在历史任务中查看`, finished.some(task => task.status === 'failed'));
    renderHistory();
    const id = state.activeTaskId;
    const version = taskViewVersion;
    const summary = state.tasks.find(task => task.id === id);
    if (summary && (!state.viewedTask || activeTask(state.viewedTask) || state.viewedTask.updatedAt !== summary.updatedAt || state.viewedTask.status !== summary.status)) {
      const { task } = await api(`/api/tasks/${encodeURIComponent(id)}`);
      if (version === taskViewVersion && state.activeTaskId === id) displayTask(task);
    }
    state.taskMonitorError = false; renderHistory();
  })();
  try { return await historyRequest; }
  catch (error) { state.taskMonitorError = true; renderHistory(); throw error; }
  finally {
    historyRequest = null;
    const active = state.tasks.filter(activeTask);
    const delay = state.taskMonitorError ? 5000 : active.length ? active.every(task => task.demo) ? 500 : 1600 : 10000;
    historyPollTimer = setTimeout(() => refreshHistory().catch(() => {}), delay);
  }
}
function openConfig() {
  closeSidebar(false);
  $('#configDialog').showModal();
}
['connectionButton', 'settingsButton', 'workspaceButton', 'modeBadge'].forEach(id => $(`#${id}`).onclick = openConfig);
$('#closeConfig').onclick = () => $('#configDialog').close();
$('#configDialog').onclick = event => { if (event.target === $('#configDialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } };
async function loadConfig() {
  const config = await api('/api/config'); state.config = config;
  $('#workspaceName').textContent = config.project || '创作空间';
  $('#connectionText').textContent = config.configured ? 'Agent 配置就绪' : config.filesApiConfigured ? 'Key 已配置 · 待配置 Agent' : '演示模式 · 未配置 Key';
  $('#connectionDot').classList.toggle('ready', config.configured);
  $('#modeLabel').textContent = config.configured ? 'Seedance Managed Agent' : '演示模式 · 查看配置';
  $('#modeBadge').classList.toggle('live', config.configured);
  const rows = [['执行引擎', config.provider || 'Seedance Managed Agent', Boolean(config.configured)], ['项目', config.project || 'default', true], ['API Key', config.filesApiConfigured ? '已配置（调用时校验）' : '未配置', config.filesApiConfigured], ['视觉创作 Agent', config.configured ? '配置就绪（调用时校验）' : '缺少 Agent ID 或模型配置', config.configured], ['私域素材库 AK/SK', config.avatarLibraryConfigured ? '已配置（调用时校验权限）' : '未配置', config.avatarLibraryConfigured], ['虚拟人像素材库', config.avatarLibraryConfigured ? 'AIGC 素材组 · 支持本地文件与 URL 入库' : '待配置 AK/SK', config.avatarLibraryConfigured]];
  $('#configRows').innerHTML = rows.map(([label, value, ready]) => `<div class="config-row"><span>${escapeHtml(label)}</span><span class="${ready ? 'ready' : ''}">${escapeHtml(value)}</span></div>`).join('');
  $('#portraitConfigNotice').textContent = !config.avatarLibraryConfigured ? '人像入库需要配置 AK/SK；真人与虚拟角色统一走 AIGC 库审核。' : '当前人像创作统一使用 AIGC 素材组，不按真人或虚拟角色分流；平台审核 Active 后生成。';
  renderAssets();
}
showView();
selectCollection('virtual-avatar');
Promise.allSettled([
  loadConfig().then(() => { refreshAvatarGroups().catch(error => { $('#avatarGroupStatus').textContent = `素材组暂时无法同步：${error.message}`; }); }).catch(error => { $('#connectionText').textContent = '服务连接异常'; $('#connectionDot').classList.add('offline'); toast(error.message, true); }),
  refreshAssets().catch(error => toast(`素材库暂时无法同步：${error.message}`, true)),
  refreshHistory().catch(error => toast(`会话列表暂时无法同步：${error.message}`, true))
]).then(async () => {
  let id; try { id = localStorage.getItem('visionary-active-task'); } catch {}
  if (id && state.tasks.some(item => item.id === id) && !state.activeTaskId && ['', '#studio'].includes(location.hash)) await openTask(id);
}).catch(error => toast(error.message, true));
