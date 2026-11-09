import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { status: 400 });
export const settingFields = [
  { key: 'ARK_API_KEY', label: 'API Key', group: 'connection', secret: true, help: '用于 Managed Agent、图片、视频和 Files API。' },
  { key: 'ARK_BASE_URL', label: 'API 地址', group: 'connection', type: 'url', default: 'https://ark.cn-beijing.volces.com/api/v3', help: '需兼容方舟 Managed Agents API；不是 Chat Completions 接口。' },
  { key: 'ARK_PROJECT_NAME', label: '项目名称', group: 'connection', default: 'yingke' },
  { key: 'ARK_AGENT_ID', label: 'Agent ID', group: 'agent', placeholder: '复用已有 Agent 时填写' },
  { key: 'ARK_ENVIRONMENT_ID', label: 'Environment ID', group: 'agent', placeholder: '留空时自动创建并缓存' },
  { key: 'ARK_AGENT_MODEL', label: 'Agent 模型', group: 'agent', placeholder: '填写模型 ID 或接入点 ID' },
  { key: 'ARK_IMAGE_MODEL', label: '图片模型', group: 'agent', placeholder: '填写图片模型 ID 或接入点 ID' },
  { key: 'ARK_VIDEO_MODEL', label: '视频模型', group: 'agent', placeholder: '可选，填写视频模型 ID 或接入点 ID' },
  { key: 'ARK_ACCESS_KEY', label: 'Access Key（AK）', group: 'assets', secret: true },
  { key: 'ARK_SECRET_KEY', label: 'Secret Key（SK）', group: 'assets', secret: true },
  { key: 'ARK_SESSION_TOKEN', label: 'Session Token', group: 'assets', secret: true, help: '使用临时 AK/SK 时填写；长期凭据通常留空。' },
  { key: 'ARK_ASSET_GROUP_ID', label: '默认 AIGC 素材组 ID', group: 'assets', placeholder: '留空时自动创建或复用素材组' },
  { key: 'ARK_ASSET_API_URL', label: '素材 API 地址', group: 'advanced', type: 'url', default: 'https://ark.cn-beijing.volcengineapi.com/' },
  { key: 'ARK_REAL_PERSON_CALLBACK_URL', label: '真人认证回调地址', group: 'advanced', type: 'callback', help: '仅用于可选的旧版真人认证，需为你控制的公网 HTTPS 页面。' },
  { key: 'MAX_CONCURRENT_TASKS', label: '最大并发任务数', group: 'advanced', type: 'number', default: '3', help: '1–32；超出并发数的任务继续排队。' }
];
const fieldsByKey = new Map(settingFields.map(field => [field.key, field]));
const has = (object, key) => Object.hasOwn(object, key);

function normalize(field, value) {
  if (typeof value !== 'string' && !(field.type === 'number' && typeof value === 'number')) throw invalid(`${field.label}的格式不正确`);
  value = String(value).trim();
  if (value.length > (field.secret ? 4096 : field.type === 'url' || field.type === 'callback' ? 2048 : 256) || /[\x00-\x1f\x7f]/.test(value)) throw invalid(`${field.label}过长或包含无效字符`);
  if (!value) return '';
  if (field.type === 'number') {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 32) throw invalid(`${field.label}须为 1–32 的整数`);
    return String(Number(value));
  }
  if (field.type === 'url' || field.type === 'callback') {
    let url;
    try { url = new URL(value); } catch { throw invalid(`${field.label}须为有效的完整 URL`); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid(`${field.label}须为 HTTP(S) 地址，不能包含账号、密码、查询参数或片段`);
    if (field.type === 'callback' && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw invalid('真人认证回调地址须为公网 HTTPS 页面');
    if (field.type === 'url' && field.key === 'ARK_ASSET_API_URL' && url.pathname !== '/') throw invalid('素材 API 地址只能包含域名和端口，不能包含路径');
    return field.key === 'ARK_BASE_URL' ? url.href.replace(/\/+$/, '') : url.href;
  }
  return value;
}

// An empty override deliberately disables an inherited credential. null removes
// an override. Secret values never form part of the public representation.
export function createSettings({ dataDir, env = process.env }) {
  const filename = path.join(dataDir, 'settings.json');
  const inherited = Object.fromEntries(settingFields.map(field => [field.key, String(env[field.key] || field.default || '')]));
  let overrides = {};
  let revision = crypto.randomUUID();
  const secrets = new Set(settingFields.filter(field => field.secret).map(field => inherited[field.key]).filter(Boolean));
  if (fs.existsSync(filename)) {
    let stored;
    try { stored = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('无法读取 settings.json，服务不会覆盖损坏的设置。'); }
    if (stored?.version !== 1 || typeof stored.revision !== 'string' || !stored.values || typeof stored.values !== 'object' || Array.isArray(stored.values)) throw new Error('settings.json 格式错误，服务不会覆盖已有设置。');
    try {
      for (const [key, value] of Object.entries(stored.values)) {
        if (!fieldsByKey.has(key)) throw new Error();
        overrides[key] = normalize(fieldsByKey.get(key), value);
      }
    } catch { throw new Error('settings.json 包含无效配置，请检查该文件。'); }
    revision = stored.revision;
    fs.chmodSync(filename, 0o600);
  }
  const effective = (values = overrides) => Object.fromEntries(settingFields.map(field => [field.key, has(values, field.key) ? values[field.key] || field.default || '' : inherited[field.key]]));
  const rememberSecrets = values => { for (const field of settingFields) if (field.secret && values[field.key]) secrets.add(values[field.key]); };
  rememberSecrets(effective());
  function publicSettings() {
    const values = effective();
    return {
      revision,
      fields: settingFields.map(field => ({
        ...field,
        source: has(overrides, field.key) ? 'user' : env[field.key] ? 'environment' : 'default',
        ...(field.secret ? { configured: Boolean(values[field.key]), inheritedConfigured: Boolean(inherited[field.key]) } : { value: values[field.key], inheritedValue: inherited[field.key] })
      }))
    };
  }
  function prepare(body) {
    if (typeof body.revision !== 'string' || body.revision !== revision) throw Object.assign(new Error('设置已被其他页面更新，请重新加载设置后再保存。'), { status: 409 });
    if (Object.keys(body).some(key => !['revision', 'values', 'reset'].includes(key)) || body.reset !== undefined && typeof body.reset !== 'boolean' || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw invalid('设置请求格式不正确');
    const next = body.reset ? {} : { ...overrides };
    for (const [key, value] of Object.entries(body.values)) {
      const field = fieldsByKey.get(key);
      if (!field) throw invalid('包含不支持的设置项');
      if (value === null) delete next[key];
      else next[key] = normalize(field, value);
    }
    const values = effective(next);
    rememberSecrets(values);
    return { overrides: next, values, changed: JSON.stringify(next) !== JSON.stringify(overrides), revision };
  }
  function commit(candidate) {
    if (candidate.revision !== revision) throw Object.assign(new Error('设置已更新，请重新加载。'), { status: 409 });
    if (!candidate.changed) return;
    const nextRevision = crypto.randomUUID();
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, revision: nextRevision, values: candidate.overrides }, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
    overrides = candidate.overrides;
    revision = nextRevision;
  }
  function redact(value) {
    return [...secrets].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join('[已隐藏]'), String(value));
  }
  return { effective, publicSettings, prepare, commit, redact };
}
