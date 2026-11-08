import fs from 'node:fs';
import crypto from 'node:crypto';
import { createManagedSessionClient } from './managed-session.js';
import { generationInstructions } from './generation-policy.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, milliseconds);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

async function responseJson(response, label) {
  const text = await response.text();
  if (response.ok && !text.trim()) return {};
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${label} 返回了非 JSON 响应（HTTP ${response.status}），请检查接口地址。`); }
  if (!response.ok || data?.ResponseMetadata?.Error) throw Object.assign(new Error(data?.error?.message || data?.ResponseMetadata?.Error?.Message || data?.message || `${label} 失败（HTTP ${response.status}）`), { status: response.status });
  return data;
}

export function createArkClient({ readStore, saveStore }) {
  const apiKey = process.env.ARK_API_KEY || '';
  const baseUrl = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
  const assetApiUrl = process.env.ARK_ASSET_API_URL || 'https://ark.cn-beijing.volcengineapi.com/';
  const project = process.env.ARK_PROJECT_NAME || 'yingke';
  const agentId = process.env.ARK_AGENT_ID || '';
  const environmentId = process.env.ARK_ENVIRONMENT_ID || '';
  const agentModel = process.env.ARK_AGENT_MODEL || '';
  const imageModel = process.env.ARK_IMAGE_MODEL || '';
  const videoModel = process.env.ARK_VIDEO_MODEL || '';
  const config = { configured: Boolean(apiKey && (agentId || (agentModel && imageModel))), filesApiConfigured: Boolean(apiKey), avatarLibraryConfigured: Boolean(process.env.ARK_ACCESS_KEY && process.env.ARK_SECRET_KEY), realPersonCallbackConfigured: Boolean(process.env.ARK_REAL_PERSON_CALLBACK_URL), project };
  const fingerprint = sha256(JSON.stringify({ baseUrl, project, key: sha256(apiKey), agentId, environmentId, agentModel, imageModel, videoModel }));
  const cached = readStore('agent-resources.json', {});
  let resources = cached.fingerprint === fingerprint ? cached : { fingerprint };
  let resourcesPromise;
  let groupPromise;
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function request(endpoint, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await fetch(`${baseUrl}${endpoint}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(60000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error.cause?.code || (error.name === 'TimeoutError' ? '请求超时' : '网络连接失败');
      throw new Error(`无法连接方舟 Agent API（${reason}）。请检查本机网络、代理和 ARK_BASE_URL 后重试；不会自动重发请求。`, { cause: error });
    }
    return responseJson(response, '方舟 Agent API');
  }
  async function prepareResources() {
    if (resourcesPromise) return resourcesPromise;
    resourcesPromise = (async () => {
      if (agentId) resources.agentId = agentId;
      if (!resources.agentId) {
        const tools = [
          { name: 'image_generate', enabled: true, models: [{ id: imageModel, default: true }] },
          ...(videoModel ? [{ name: 'video_generate', enabled: true, models: [{ id: videoModel, default: true }] }] : []),
          { name: 'visual_search', enabled: true }, { name: 'general_search', enabled: true },
          { name: 'compose_video', enabled: true }, { name: 'todo_write', enabled: true }
        ];
        const agent = await request('/agents', { method: 'POST', body: {
          name: `visionary-${project}-${Date.now()}`.slice(0, 64), description: 'Visionary visual creation demo', base_agent: 'ultra_vision_agent_preview',
          model: { id: agentModel, reasoning_effort: 'high' },
          system: `你是视觉创作 Agent。根据用户需求与有权使用的参考素材创作。使用可用工具完成任务，不要声称生成了不存在的产物。把最终可下载文件保存到 /mnt/session/outputs/，最后用中文总结实际完成的内容和文件名。\n${generationInstructions}`,
          tools: [{ type: 'agent_toolset_20260916', default_config: { enabled: true }, configs: [{ name: 'web_search', enabled: false }] }, { type: 'agent_toolset_multimodal_20260825', default_config: { enabled: false }, configs: tools }]
        } });
        if (!agent.id) throw new Error('创建 Agent 未返回 ID，请检查模型配置及开通权限。');
        resources.agentId = agent.id;
        saveStore('agent-resources.json', resources);
      }
      if (environmentId) resources.environmentId = environmentId;
      if (!resources.environmentId) {
        const environment = await request('/environments', { method: 'POST', body: { name: `visionary-${Date.now()}`, description: 'Local visual creation demo sandbox', config: { type: 'cloud', networking: { type: 'unrestricted' } } } });
        if (!environment.id) throw new Error('创建 Environment 未返回 ID');
        resources.environmentId = environment.id;
      }
      saveStore('agent-resources.json', resources);
      return resources;
    })();
    try { return await resourcesPromise; }
    finally { resourcesPromise = undefined; }
  }
  async function uploadFile(filePath, filename, contentType) {
    if (!apiKey) throw new Error('Files API 尚未配置 API Key');
    const form = new FormData();
    form.append('purpose', 'agent');
    form.append('file', await fs.openAsBlob(filePath, { type: contentType }), filename);
    let response;
    try { response = await fetch(`${baseUrl}/files`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(10 * 60 * 1000) }); }
    catch (error) {
      const reason = error.cause?.code || error.message;
      throw new Error(`无法连接方舟 Files API（${reason}）。请检查本机网络和 ARK_BASE_URL 后重试。`);
    }
    const result = await responseJson(response, 'Files API 上传');
    if (!result.id) throw new Error('Files API 未返回文件 ID');
    return result;
  }
  async function collectOutputs(task, selectedAssets, update, signal) {
    let files = [];
    let previousIds = '';
    const inputNames = new Set([...selectedAssets.map(item => item.name), ...selectedAssets.map(item => `${item.id.slice(0, 8)}-${item.name.replace(/[\\/\x00-\x1f]/g, '_')}`)]);
    for (let attempt = 0; attempt < 10; attempt++) {
      const query = new URLSearchParams({ scope_id: task.sessionId, purpose: 'agent' });
      const result = await request(`/files?${query}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      const generated = [...new Map([...Object.values(task.assetVideoJobs || {}), ...Object.values(task.imageGenerationJobs || {})].filter(item => item.file).map(item => [item.file.id, item.file])).values()];
      const registered = (Array.isArray(result?.data) ? result.data : []).filter(item => item.download_url && !inputNames.has(item.filename) && (!item.filename?.startsWith('/mnt/session/') || item.filename.startsWith('/mnt/session/outputs/'))).map(item => ({ id: item.id, filename: item.filename || '创作产物', mime_type: item.mime_type || 'application/octet-stream', download_url: item.download_url }));
      files = [...generated, ...registered.filter(item => !generated.some(video => video.filename === item.filename))];
      const ids = files.map(item => item.id).sort().join(',');
      if (files.length && ids === previousIds) break;
      previousIds = ids;
      if (attempt < 9) {
        update({ collectingOutputs: true, files, detail: files.length ? `已发现 ${files.length} 份产物，等待文件注册稳定。` : '等待平台注册产物；文本方案可能没有文件。' });
        await wait(2000, signal);
      }
    }
    update({ status: 'completed', collectingOutputs: false, files, error: undefined, detail: files.length ? `创作结束，已注册 ${files.length} 份产物。` : '会话已结束，暂无已注册文件；请查看 Agent 回复。' }, { type: 'task.completed', label: '产物查询完成' });
  }
  async function refreshOutputs(task, selectedAssets, update) {
    const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`);
    if (session?.status !== 'idle') throw new Error('方舟会话尚未结束，不能刷新为已完成。');
    await collectOutputs(task, selectedAssets, update);
  }
  const managed = createManagedSessionClient({ baseUrl, headers, request, prepareResources, collectOutputs, project });
  const runTask = (task, selectedAssets, update, controls = {}) => managed.run(task, selectedAssets, update, { reuseSession: false, ...controls });
  async function callAssetApi(action, payload) {
    if (!config.avatarLibraryConfigured) throw new Error('私域虚拟人像库需要 Access Key / Secret Key，API Key 不能替代。');
    const endpoint = new URL(assetApiUrl);
    const canonicalQuery = new URLSearchParams({ Action: action, Version: '2024-01-01' }).toString();
    const body = JSON.stringify(payload);
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = date.slice(0, 8);
    const contentHash = sha256(body);
    const signable = { host: endpoint.host, 'x-content-sha256': contentHash, 'x-date': date, ...(process.env.ARK_SESSION_TOKEN ? { 'x-security-token': process.env.ARK_SESSION_TOKEN } : {}) };
    const signedHeaders = Object.keys(signable).sort().join(';');
    const canonicalHeaders = Object.keys(signable).sort().map(name => `${name}:${signable[name]}`).join('\n');
    const canonicalRequest = ['POST', endpoint.pathname || '/', canonicalQuery, `${canonicalHeaders}\n`, signedHeaders, contentHash].join('\n');
    const scope = `${dateStamp}/cn-beijing/ark/request`;
    const stringToSign = `HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`;
    const signingKey = hmac(hmac(hmac(hmac(process.env.ARK_SECRET_KEY, dateStamp), 'cn-beijing'), 'ark'), 'request');
    const authorization = `HMAC-SHA256 Credential=${process.env.ARK_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign, 'hex')}`;
    const response = await fetch(`${endpoint.origin}${endpoint.pathname}?${canonicalQuery}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Date': date, 'X-Content-Sha256': contentHash, ...(process.env.ARK_SESSION_TOKEN ? { 'X-Security-Token': process.env.ARK_SESSION_TOKEN } : {}), Authorization: authorization }, body, signal: AbortSignal.timeout(30000) });
    const result = await responseJson(response, '方舟私域资产 API');
    return result.Result || result;
  }
  async function getVirtualGroup(id) {
    const group = await callAssetApi('GetAssetGroup', { Id: id, ProjectName: project });
    if (group?.Id !== id || group.GroupType !== 'AIGC' || group.ProjectName !== project) throw new Error('素材组必须属于当前项目，且 GroupType 为 AIGC。');
    return group;
  }
  async function createVirtualGroup(name) {
    const group = await callAssetApi('CreateAssetGroup', { Name: name, Description: 'Visionary 私域虚拟人像素材', GroupType: 'AIGC', ProjectName: project });
    if (!group.Id) throw new Error('创建素材组未返回 ID，请到方舟控制台确认结果后再操作。');
    return { ...group, Name: name, GroupType: 'AIGC', ProjectName: project };
  }
  async function prepareGroup(id) {
    if (id || process.env.ARK_ASSET_GROUP_ID) return (await getVirtualGroup(id || process.env.ARK_ASSET_GROUP_ID)).Id;
    if (groupPromise) return groupPromise;
    groupPromise = (async () => {
      const cachedGroup = readStore('avatar-group.json', {});
      const identity = sha256(`${assetApiUrl}/${project}/${process.env.ARK_ACCESS_KEY}`);
      if (cachedGroup.identity === identity && cachedGroup.id) return (await getVirtualGroup(cachedGroup.id)).Id;
      const group = await createVirtualGroup(`${project}-virtual-avatar-assets`.slice(0, 64));
      saveStore('avatar-group.json', { id: group.Id, project, identity });
      return group.Id;
    })();
    try { return await groupPromise; } finally { groupPromise = undefined; }
  }
  async function createAvatar({ name, assetUrl, assetType, groupId: destination }) {
    const groupId = await prepareGroup(destination);
    const result = await callAssetApi('CreateAsset', { GroupId: groupId, URL: assetUrl, Name: name, AssetType: assetType, ProjectName: project });
    if (!result.Id) throw new Error('创建素材未返回资产 ID，请到控制台确认是否已提交，不要重复入库。');
    return { groupId, assetId: result.Id };
  }
  return {
    config: { ...config, provider: 'Seedance Managed Agent', capabilities: { conversations: true, interrupt: true, resume: true, goals: true, streaming: true } }, managed, uploadFile, runTask, refreshOutputs, createAvatar, prepareVirtualGroup: prepareGroup, getVirtualGroup, createVirtualGroup,
    listVirtualGroups: nextToken => callAssetApi('ListAssetGroups', { ProjectName: project, Filter: { GroupType: 'AIGC' }, MaxResults: 100, SortBy: 'CreateTime', SortOrder: 'Desc', ...(nextToken ? { NextToken: nextToken } : {}) }),
    listVirtualAssets: async (groupId, nextToken) => {
      await getVirtualGroup(groupId);
      return callAssetApi('ListAssets', { ProjectName: project, Filter: { GroupIds: [groupId], GroupType: 'AIGC' }, MaxResults: 100, SortBy: 'CreateTime', SortOrder: 'Desc', ...(nextToken ? { NextToken: nextToken } : {}) });
    },
    getFile: id => request(`/files/${encodeURIComponent(id)}`),
    createImage: body => request('/images/generations', { method: 'POST', body: { ...body, watermark: false }, signal: AbortSignal.timeout(10 * 60 * 1000) }),
    createVideo: body => request('/contents/generations/tasks', { method: 'POST', body: { ...body, watermark: false } }),
    getVideo: (id, signal) => request(`/contents/generations/tasks/${encodeURIComponent(id)}`, { signal }),
    videoModel: async task => {
      if (videoModel) return videoModel;
      const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`);
      const models = session.agent?.tools?.find(tool => tool.type === 'agent_toolset_multimodal_20260825')?.configs?.find(tool => tool.name === 'video_generate')?.models || [];
      const model = models.find(model => model.default) || models[0];
      if (!model?.id) throw new Error('未找到可用的视频模型，请配置 ARK_VIDEO_MODEL 或为 Agent 配置 video_generate 模型。');
      return model.id;
    },
    imageModel: async task => {
      if (imageModel) return imageModel;
      const session = await request(`/sessions/${encodeURIComponent(task.sessionId)}`);
      const models = session.agent?.tools?.find(tool => tool.type === 'agent_toolset_multimodal_20260825')?.configs?.find(tool => tool.name === 'image_generate')?.models || [];
      const model = models.find(item => item.default) || models[0];
      if (!model?.id) throw new Error('未找到可用的图片模型，请配置 ARK_IMAGE_MODEL 或为 Agent 配置 image_generate 模型。');
      return model.id;
    },
    getAvatar: id => callAssetApi('GetAsset', { Id: id, ProjectName: project }),
    getGroup: id => callAssetApi('GetAssetGroup', { Id: id, ProjectName: project }),
    createVerification: callbackUrl => callAssetApi('CreateVisualValidateSession', { CallbackURL: callbackUrl, ProjectName: project }),
    getVerification: token => callAssetApi('GetVisualValidateResult', { BytedToken: token, ProjectName: project }),
    createPortrait: async ({ groupId, assetUrl, name, assetType }) => {
      const result = await callAssetApi('CreateAsset', { GroupId: groupId, URL: assetUrl, Name: name, AssetType: assetType, ProjectName: project });
      if (!result.Id) throw new Error('未返回资产 ID；请先在方舟控制台核实，避免重复入库。');
      return result.Id;
    }
  };
}
