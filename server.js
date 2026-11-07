import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createArkClient } from './lib/ark.js';
import { createPortraitLibrary } from './lib/portraits.js';
import { createAvatarLibrary } from './lib/avatars.js';
import { createTaskQueue } from './lib/task-queue.js';
import { createConversations } from './lib/conversations.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = process.env.VISIONARY_ENV_FILE || path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const maxConcurrentTasks = Number(process.env.MAX_CONCURRENT_TASKS || 3);
const taskQueue = createTaskQueue(maxConcurrentTasks);
const dataDir = path.resolve(process.env.VISIONARY_DATA_DIR || path.join(root, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
const maxUploadBytes = 512 * 1024 * 1024;
const contentTypes = {
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain', '.md': 'text/plain', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg'
};
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/portrait-callback/': ['portrait-callback/index.html', 'text/html; charset=utf-8'],
  '/portrait-callback/index.html': ['portrait-callback/index.html', 'text/html; charset=utf-8'],
  '/portrait-callback/callback.css': ['portrait-callback/callback.css', 'text/css; charset=utf-8'],
  '/portrait-callback/callback.js': ['portrait-callback/callback.js', 'text/javascript; charset=utf-8']
};
const cleanName = value => path.basename(String(value || 'upload').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'upload';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const httpError = (status, message) => Object.assign(new Error(message), { status });
const redact = value => [process.env.ARK_API_KEY, process.env.ARK_ACCESS_KEY, process.env.ARK_SECRET_KEY, process.env.ARK_SESSION_TOKEN].filter(Boolean).reduce((text, secret) => text.split(secret).join('[已隐藏]'), String(value));

function readStore(name, fallback) {
  const filePath = path.join(dataDir, name);
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error(`无法读取 data/${name}，请检查该文件，服务不会覆盖损坏的数据。`); }
}
function saveStore(name, value) {
  const filePath = path.join(dataDir, name);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}
const ark = createArkClient({ readStore, saveStore });
let assets = readStore('assets.json', []);
const tasks = readStore('tasks.json', []);
if (!Array.isArray(assets) || !Array.isArray(tasks)) throw new Error('素材或任务记录格式错误，请检查 data 目录。');
saveStore('tasks.json', tasks);
const persistAssets = () => saveStore('assets.json', assets);
const persistTasks = () => saveStore('tasks.json', tasks);
const refreshingTasks = new Set();
const syncingAssets = new Set();
const subscribers = new Map();
function publicAsset(item) {
  const fields = ['id', 'name', 'type', 'size', 'collection', 'createdAt', 'status', 'error', 'arkFileId', 'assetId', 'remoteStatus', 'groupId', 'enrollmentState', 'project'];
  return { ...Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]])), hasLocalFile: Boolean(item.localPath) };
}
const portraits = createPortraitLibrary({
  ark, readStore, saveStore, persistAssets, redact,
  findAsset: id => assets.find(item => item.id === id),
  resolvePath: item => {
    if (!item.localPath || path.basename(item.localPath) !== item.localPath) throw httpError(404, '本机素材文件不存在');
    return path.join(uploadDir, item.localPath);
  }
});
const avatars = createAvatarLibrary({
  ark, getAssets: () => assets, persistAssets, redact,
  resolvePath: item => {
    if (!item.localPath || path.basename(item.localPath) !== item.localPath) throw httpError(404, '本机素材文件不存在');
    return path.join(uploadDir, item.localPath);
  }
});
for (const item of assets) {
  if (['uploading', 'submitting'].includes(item.enrollmentState)) {
    item.enrollmentState = item.enrollmentState === 'submitting' ? 'unknown' : 'failed';
    item.status = item.enrollmentState === 'unknown' ? '提交结果未确认 · 请在控制台核实' : '上传已中断 · 本机文件仍保留';
    item.error = '服务已重启，停止跟踪原上传；不会自动重新提交入库。';
  }
}
persistAssets();
function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 64 * 1024) { request.resume(); throw httpError(413, '请求内容不能超过 64 KB'); }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw httpError(400, '请求必须是有效的 JSON 对象'); }
}
function validateOptions(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw httpError(400, '创作参数格式错误');
  const aspectRatio = value.aspectRatio || '1:1';
  const style = value.style || '自然写实';
  if (!['1:1', '16:9', '9:16', '4:3'].includes(aspectRatio)) throw httpError(400, '不支持的画面比例');
  if (!['自然写实', '电影质感', '艺术插画', '极简设计'].includes(style)) throw httpError(400, '不支持的创作风格');
  return { aspectRatio, style, optimize: value.optimize !== false, versions: value.versions === true };
}
function updateTask(task, patch, event) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString(), revision: (task.revision || 0) + 1 });
  if (event) task.events = [...task.events.slice(-79), { ...event, at: task.updatedAt }];
  persistTasks();
  for (const response of subscribers.get(task.id) || []) {
    if (!response.destroyed && response.writableLength < 2 * 1024 * 1024) response.write(`id: ${task.revision}\nevent: task\ndata: ${JSON.stringify(task)}\n\n`);
    else response.destroy();
  }
}
function demoResult(task, selectedAssets) {
  return `【交互演示 · 非模型生成】\n\n你的创作需求\n${task.prompt}\n\n创作设定\n画面比例：${task.options.aspectRatio}  ·  视觉风格：${task.options.style}\n提示词优化：${task.options.optimize ? '开启' : '关闭'}  ·  方向数量：${task.options.versions ? '多个方向' : '单一方向'}\n\n01 / 视觉方向\n以一个清晰的主体为视觉锚点，利用留白建立叙事节奏。采用低饱和底色，搭配一处温暖的重点色，让光影与材质共同传达情绪。\n\n02 / 画面组织\n前景保留少量环境线索，中景呈现主体，背景降低细节密度。主光从侧面进入，保留自然阴影与真实质感；文字区域保持干净，避免与主体争夺注意力。\n\n03 / 短片分镜参考\n00–04 秒：环境全景，缓慢推进，建立空间氛围。\n04–10 秒：主体中近景，展示材质、细节与核心动作。\n10–15 秒：固定构图收束，保留品牌或标题的排版空间。\n${task.options.versions ? '\n备选方向\nA. 温暖自然光：克制、安静、日常。\nB. 冷暖撞色：鲜明、现代、具有辨识度。\nC. 单色几何：简洁、抽象、强调形态。\n' : ''}\n参考素材：${selectedAssets.length} 份（演示模式未读取或分析文件内容）。\n\n本结果是本机预置方案，用于验证页面交互、任务记录与下载流程，不是模型回复，也没有生成真实图像或视频。配置视觉 Agent 后，同一入口会提交真实方舟会话。`;
}
const conversations = createConversations({ tasks, ark, taskQueue, update: updateTask, persist: persistTasks, getAssets: () => assets, validateOptions, redact, demoResult });
async function receiveUpload(request, filePath) {
  let size = 0;
  const file = await fs.promises.open(filePath, 'wx', 0o600);
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxUploadBytes) { request.resume(); throw httpError(413, '文件不能超过 512 MB'); }
      await file.writeFile(chunk);
    }
    if (!size) throw httpError(400, '文件不能为空');
    return size;
  } finally { await file.close(); }
}
async function uploadAsset(request, response) {
  const collection = request.headers['x-collection'] || 'reference';
  if (!['reference', 'private-person', 'virtual-avatar'].includes(collection)) throw httpError(400, '未知素材分类');
  let filename;
  try { filename = cleanName(decodeURIComponent(request.headers['x-file-name'] || '')); }
  catch { throw httpError(400, '文件名编码无效'); }
  const extension = path.extname(filename).toLowerCase();
  const contentType = contentTypes[extension];
  if (!contentType) throw httpError(415, '仅支持文档、图片、视频或音频；请检查文件扩展名');
  if (collection === 'private-person' && !/^(image|video)\//.test(contentType)) throw httpError(400, '真人素材分类仅支持图片和视频');
  if (collection === 'virtual-avatar' && !/^(image|video|audio)\//.test(contentType)) throw httpError(400, '虚拟素材库支持图片、视频和音频；文档请上传到参考素材。');
  if (collection === 'virtual-avatar' && contentType.startsWith('image/') && Number(request.headers['content-length']) >= 30 * 1024 * 1024) throw httpError(413, '虚拟人像图片需小于 30 MB。');
  if (Number(request.headers['content-length']) > maxUploadBytes) {
    request.resume();
    response.setHeader('Connection', 'close');
    throw httpError(413, '文件不能超过 512 MB');
  }
  const storageName = `${crypto.randomUUID()}${extension}`;
  const filePath = path.join(uploadDir, storageName);
  try {
    const size = await receiveUpload(request, filePath);
    if (collection === 'virtual-avatar' && contentType.startsWith('image/') && size >= 30 * 1024 * 1024) throw httpError(413, '虚拟人像图片需小于 30 MB。');
    const item = { id: crypto.randomUUID(), name: filename, type: contentType, size, collection, createdAt: new Date().toISOString(), localPath: storageName };
    if (collection !== 'reference') item.status = '本机已保存 · 待提交入库';
    else if (!ark.config.filesApiConfigured) item.status = '本机保存 · 待配置 API Key';
    else {
      try {
        const remote = await ark.uploadFile(filePath, filename, contentType);
        item.arkFileId = remote.id;
        item.status = '已同步方舟 Files API';
      } catch (error) {
        item.status = '本机已保存 · 方舟同步失败';
        item.error = redact(error.message);
      }
    }
    assets.unshift(item);
    persistAssets();
    send(response, 201, { item: publicAsset(item) });
  } catch (error) {
    await fs.promises.rm(filePath, { force: true });
    throw error;
  }
}
async function syncReferenceAsset(id) {
  const item = assets.find(record => record.id === id);
  if (!item) throw httpError(404, '素材不存在');
  if (item.collection !== 'reference') throw httpError(400, '只有参考素材可以同步到 Agent Files API');
  if (item.arkFileId) return item;
  if (!ark.config.filesApiConfigured) throw httpError(503, '请先在服务端配置 ARK_API_KEY，再同步到方舟 Files API');
  if (!item.localPath || path.basename(item.localPath) !== item.localPath) throw httpError(404, '本机素材文件不存在');
  const filePath = path.join(uploadDir, item.localPath);
  if (!fs.existsSync(filePath)) throw httpError(404, '本机素材文件不存在');
  if (syncingAssets.has(id)) throw httpError(409, '该素材正在同步，请稍后查看状态');
  syncingAssets.add(id);
  try {
    try {
      const remote = await ark.uploadFile(filePath, item.name, item.type);
      item.arkFileId = remote.id;
      item.status = '已同步方舟 Files API';
      delete item.error;
      persistAssets();
      return item;
    } catch (error) {
      item.status = '本机已保存 · 方舟同步失败';
      item.error = redact(error.message);
      persistAssets();
      throw httpError(502, `${item.error} 文件已保存在本机，可稍后重试同步。`);
    }
  } finally { syncingAssets.delete(id); }
}
function serveAsset(request, response, item) {
  if (!item?.localPath || path.basename(item.localPath) !== item.localPath) throw httpError(404, '本机素材不存在');
  const filePath = path.join(uploadDir, item.localPath);
  if (!fs.existsSync(filePath)) throw httpError(404, '本机素材文件不存在');
  const size = fs.statSync(filePath).size;
  const headers = { 'Content-Type': contentTypes[path.extname(item.localPath)] || 'application/octet-stream', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(cleanName(item.name))}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
  let start = 0;
  let end = size - 1;
  if (request.headers.range) {
    const match = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); return response.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); return response.end(); }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  response.writeHead(request.headers.range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
  if (request.method === 'HEAD') return response.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
async function refreshAvatarAssets() {
  if (!ark.config.avatarLibraryConfigured) return;
  const pending = assets.filter(item => item.assetId && item.remoteStatus === 'Processing' && Date.now() - (item.checkedAt || 0) > 15000).slice(0, 3);
  await Promise.all(pending.map(async item => {
    item.checkedAt = Date.now();
    try {
      const remote = await ark.getAvatar(item.assetId);
      item.remoteStatus = remote.Status || 'Processing';
      item.status = { Active: 'Active · 审核通过', Processing: 'Processing · 方舟处理中', Failed: 'Failed · 方舟审核失败' }[item.remoteStatus] || item.remoteStatus;
      delete item.error;
      if (item.remoteStatus === 'Failed') item.error = item.collection === 'virtual-avatar' ? '方舟预处理或审核未通过，请在控制台查看虚拟素材规范与权益容量。' : '方舟预处理或安全审核未通过。真人素材须与认证基准为同一人；请在控制台查看详情。';
    } catch (error) { item.error = redact(error.message); }
  }));
  if (pending.length) persistAssets();
}
async function route(request, response) {
  const url = new URL(request.url, `http://localhost:${port}`);
  const requestHost = new URL(`http://${request.headers.host || 'localhost'}`).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(requestHost)) throw httpError(403, '此 Demo 仅允许本机访问');
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin) {
    const origin = new URL(request.headers.origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || Number(origin.port || 80) !== port) throw httpError(403, '不允许跨站请求');
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return send(response, 200, ark.config);
  if (request.method === 'GET' && url.pathname === '/api/avatar-groups') {
    const result = await ark.listVirtualGroups(url.searchParams.get('nextToken'));
    const items = (Array.isArray(result.Items) ? result.Items : []).filter(group => group.GroupType === 'AIGC' && group.ProjectName === ark.config.project).map(group => ({ id: group.Id, name: group.Name || group.Id, project: group.ProjectName, type: group.GroupType }));
    return send(response, 200, { items, nextToken: result.NextToken || null });
  }
  if (request.method === 'POST' && url.pathname === '/api/avatar-groups') {
    const body = await readBody(request);
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64)) throw httpError(400, '素材组名称需为 1–64 字。');
    const group = body.name ? await ark.createVirtualGroup(body.name.trim()) : await ark.getVirtualGroup(await ark.prepareVirtualGroup());
    return send(response, 201, { group: { id: group.Id, name: group.Name || group.Id, project: group.ProjectName, type: group.GroupType } });
  }
  if (request.method === 'POST' && url.pathname === '/api/avatar-assets/sync') {
    const body = await readBody(request);
    if (typeof body.groupId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(body.groupId) || (body.nextToken !== undefined && (typeof body.nextToken !== 'string' || body.nextToken.length > 4096))) throw httpError(400, '需要有效素材组 ID 和分页参数。');
    return send(response, 200, await avatars.sync(body.groupId, body.nextToken));
  }
  if (request.method === 'GET' && url.pathname === '/api/portrait-verifications') return send(response, 200, { items: portraits.list() });
  if (request.method === 'POST' && url.pathname === '/api/portrait-verifications') return send(response, 201, { verification: await portraits.createVerification(await readBody(request)) });
  if (request.method === 'POST' && url.pathname === '/api/portrait-verifications/import') return send(response, 200, { verification: await portraits.importGroup(await readBody(request)) });
  const verificationRoute = url.pathname.match(/^\/api\/portrait-verifications\/([^/]+)\/refresh$/);
  if (request.method === 'POST' && verificationRoute) {
    await readBody(request);
    return send(response, 200, { verification: await portraits.refreshVerification(verificationRoute[1]) });
  }
  if (request.method === 'GET' && url.pathname === '/api/assets') {
    await refreshAvatarAssets();
    return send(response, 200, { items: assets.map(publicAsset) });
  }
  if (request.method === 'POST' && url.pathname === '/api/uploads') return uploadAsset(request, response);
  const syncAssetRoute = url.pathname.match(/^\/api\/assets\/([^/]+)\/sync$/);
  if (request.method === 'POST' && syncAssetRoute) return send(response, 200, { item: publicAsset(await syncReferenceAsset(syncAssetRoute[1])) });
  const enrollRoute = url.pathname.match(/^\/api\/assets\/([^/]+)\/enroll$/);
  if (request.method === 'POST' && enrollRoute) {
    const body = await readBody(request);
    const item = assets.find(record => record.id === enrollRoute[1]);
    return send(response, 202, { item: publicAsset(item?.collection === 'virtual-avatar' ? avatars.submitAsset(enrollRoute[1], body) : portraits.submitAsset(enrollRoute[1], body)) });
  }
  const assetRoute = url.pathname.match(/^\/api\/assets\/([^/]+)(\/content)?$/);
  if (assetRoute) {
    const item = assets.find(record => record.id === assetRoute[1]);
    if (!item) throw httpError(404, '素材不存在');
    if (['GET', 'HEAD'].includes(request.method) && assetRoute[2]) return serveAsset(request, response, item);
    if (request.method === 'DELETE' && !assetRoute[2]) {
      if (portraits.busy(item.id) || avatars.busy(item.id)) throw httpError(409, '素材正在入库，请等待本次提交完成再删除。');
      if (item.localPath && path.basename(item.localPath) === item.localPath) await fs.promises.rm(path.join(uploadDir, item.localPath), { force: true });
      assets = assets.filter(record => record.id !== item.id);
      persistAssets();
      return send(response, 200, { deleted: true, message: '已删除本机记录；不删除方舟上的文件或资产。' });
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/avatar-assets') {
    return send(response, 202, { item: publicAsset(avatars.submitUrl(await readBody(request))) });
  }
  if (request.method === 'GET' && url.pathname === '/api/tasks') return send(response, 200, { items: tasks.map(conversations.summary) });
  const refreshOutputsRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/refresh-outputs$/);
  if (request.method === 'POST' && refreshOutputsRoute) {
    await readBody(request);
    const task = tasks.find(item => item.id === refreshOutputsRoute[1]);
    if (!task) throw httpError(404, '任务不存在');
    if (task.demo || !task.sessionId || !['completed', 'failed'].includes(task.status)) throw httpError(409, '仅能刷新已结束的真实任务产物，不会重新提交创作。');
    if (conversations.jobs.has(task.id)) throw httpError(409, '会话正在执行，不能同时刷新产物');
    if (refreshingTasks.has(task.id)) throw httpError(429, '产物正在刷新，请稍后再试');
    refreshingTasks.add(task.id);
    try {
      await ark.refreshOutputs(task, (task.assetIds || []).map(id => assets.find(item => item.id === id)).filter(Boolean), (patch, event) => updateTask(task, patch, event));
      return send(response, 200, { task });
    } finally { refreshingTasks.delete(task.id); }
  }
  const controlRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(messages|pause|resume|recover|goal|confirm|settings|events|metadata)(?:\/([^/]+))?$/);
  if (controlRoute) {
    const task = conversations.find(controlRoute[1]);
    const action = controlRoute[2];
    if (request.method === 'GET' && action === 'events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`id: ${task.revision}\nevent: task\ndata: ${JSON.stringify(task)}\n\n`);
      if (!subscribers.has(task.id)) subscribers.set(task.id, new Set());
      subscribers.get(task.id).add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
      response.on('close', () => { clearInterval(heartbeat); subscribers.get(task.id)?.delete(response); if (!subscribers.get(task.id)?.size) subscribers.delete(task.id); });
      return;
    }
    if (request.method === 'DELETE' && action === 'messages' && controlRoute[3]) return send(response, 200, { task: conversations.removeQueued(task, controlRoute[3]) });
    if (request.method === 'POST') {
      const body = await readBody(request);
      if (action === 'messages') return send(response, 202, { task: conversations.postMessage(task, body) });
      if (action === 'pause') return send(response, 200, { task: await conversations.pause(task) });
      if (action === 'resume' || action === 'recover') return send(response, 202, { task: conversations.resume(task, { recoverOnly: action === 'recover' }) });
      if (action === 'goal') return send(response, 200, { task: conversations.setGoal(task, body) });
      if (action === 'confirm') return send(response, 202, { task: await conversations.confirm(task, body) });
      if (action === 'metadata') {
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120)) throw httpError(400, '会话名称须为 1–120 字');
        if (body.pinned !== undefined && typeof body.pinned !== 'boolean' || body.archived !== undefined && typeof body.archived !== 'boolean') throw httpError(400, '无效会话设置');
        updateTask(task, { ...(body.title !== undefined ? { title: body.title.trim() } : {}), ...(body.pinned !== undefined ? { pinned: body.pinned } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) });
        return send(response, 200, { task });
      }
      if (action === 'settings') {
        if (!['agent', 'plan'].includes(body.mode)) throw httpError(400, '无效会话模式');
        updateTask(task, { mode: body.mode }, { type: 'settings.updated', label: body.mode === 'plan' ? '计划模式' : 'Agent 模式' });
        return send(response, 200, { task });
      }
    }
  }
  const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (request.method === 'DELETE' && taskRoute) {
    const task = conversations.find(taskRoute[1]);
    if (conversations.jobs.has(task.id) || refreshingTasks.has(task.id)) throw httpError(409, '请先暂停会话，再删除本机记录');
    tasks.splice(tasks.indexOf(task), 1); persistTasks();
    for (const stream of subscribers.get(task.id) || []) stream.end();
    subscribers.delete(task.id);
    return send(response, 200, { deleted: true });
  }
  if (request.method === 'GET' && taskRoute) {
    const task = conversations.find(taskRoute[1]);
    return send(response, 200, { task });
  }
  if (request.method === 'POST' && ['/api/creative', '/api/conversations'].includes(url.pathname)) return send(response, 202, { task: conversations.create(await readBody(request)) });
  if (['GET', 'HEAD'].includes(request.method) && staticFiles[url.pathname]) {
    const [filename, type] = staticFiles[url.pathname];
    const content = fs.readFileSync(path.join(root, 'public', filename));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': url.pathname.startsWith('/portrait-callback/') ? 'no-store' : 'no-cache' });
    return response.end(request.method === 'HEAD' ? undefined : content);
  }
  throw httpError(404, '接口或文件不存在');
}
const server = http.createServer((request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https: http:; media-src 'self' https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  route(request, response).catch(error => {
    if (!request.readableEnded) request.resume();
    if (response.headersSent) return response.destroy();
    send(response, error.status || 502, { error: redact(error.message || '服务暂时不可用') });
  });
});
server.requestTimeout = 10 * 60 * 1000;
server.on('error', error => { console.error(`服务启动失败：${error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : redact(error.message)}`); process.exitCode = 1; });
conversations.recoverStartup();
server.listen(port, host, () => console.log(`Visionary 视觉创作工作台：http://localhost:${port} · ${ark.config.configured ? 'Agent 配置就绪' : '演示模式'}`));
