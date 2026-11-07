import crypto from 'node:crypto';

const error = (status, message) => Object.assign(new Error(message), { status });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createPortraitLibrary({ ark, readStore, saveStore, findAsset, resolvePath, persistAssets, redact }) {
  const verifications = readStore('portrait-verifications.json', []);
  if (!Array.isArray(verifications)) throw new Error('真人认证记录格式错误，请检查 data/portrait-verifications.json。');
  const enrolling = new Set();
  const refreshing = new Set();
  const save = () => saveStore('portrait-verifications.json', verifications);
  const assertConfigured = () => { if (!ark.config.avatarLibraryConfigured) throw error(400, '真人素材库需要 AK/SK 及对应项目的 ArkFullAccess 权限；API Key 无法替代。'); };
  const checkConsent = body => { if (body.consent !== true) throw error(400, '请确认肖像权授权及本次数据上传同意。'); };
  function publicVerification(item, includeLink = false) {
    const expired = Date.now() >= new Date(item.expiresAt).getTime();
    return { id: item.id, name: item.name, status: item.groupId ? 'verified' : expired ? 'expired' : 'pending', source: item.source || 'h5', groupId: item.groupId || null, createdAt: item.createdAt, expiresAt: item.expiresAt, error: item.error || null, ...(includeLink && !expired && !item.groupId ? { h5Url: item.h5Url } : {}) };
  }
  async function importGroup(body) {
    assertConfigured(); checkConsent(body);
    if (typeof body.groupId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(body.groupId)) throw error(400, '请输入方舟控制台已有的真人素材组 ID。');
    const group = await ark.getGroup(body.groupId);
    if (group?.Id !== body.groupId || group.GroupType !== 'LivenessFace' || group.ProjectName !== ark.config.project) throw error(409, '只能导入当前项目中已完成真人认证的 LivenessFace 组，AIGC 或其他项目的素材组不能用于真人入库。');
    const existing = verifications.find(item => item.groupId === group.Id && item.project === ark.config.project);
    if (existing) return publicVerification(existing);
    const item = { id: crypto.randomUUID(), name: String(group.Name || group.Id).slice(0, 64), groupId: group.Id, project: ark.config.project, createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), expiresAt: null, source: 'existing' };
    verifications.unshift(item); save();
    return publicVerification(item);
  }
  async function createVerification(body) {
    assertConfigured(); checkConsent(body);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64) throw error(400, '请填写 1–64 字的形象名称，不需要身份证号或真实姓名。');
    let callback;
    try { callback = new URL(process.env.ARK_REAL_PERSON_CALLBACK_URL); } catch { throw error(400, '请先配置 ARK_REAL_PERSON_CALLBACK_URL 为你控制的公网 HTTPS 回调页面。'); }
    if (callback.protocol !== 'https:' || callback.username || callback.password || ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)) throw error(400, '真人认证回调必须是公网可访问的 HTTPS 页面，不能是本机地址。');
    const remote = await ark.createVerification(callback.href);
    let h5Url;
    try { h5Url = new URL(remote.H5Link); } catch { throw error(502, '方舟未返回有效的真人认证链接。'); }
    if (h5Url.protocol !== 'https:' || !remote.BytedToken) throw error(502, '方舟认证响应不完整，未创建本机认证记录。');
    const item = { id: crypto.randomUUID(), name: body.name.trim(), token: remote.BytedToken, h5Url: h5Url.href, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), project: ark.config.project };
    verifications.unshift(item); save();
    return publicVerification(item, true);
  }
  async function refreshVerification(id) {
    assertConfigured();
    const item = verifications.find(record => record.id === id && record.project === ark.config.project);
    if (!item) throw error(404, '认证记录不存在。');
    if (item.groupId) return publicVerification(item);
    if (Date.now() >= new Date(item.expiresAt).getTime()) throw error(410, '认证凭证已超过 30 分钟有效期，请重新创建认证。');
    if (refreshing.has(id) || Date.now() - (item.checkedAt || 0) < 3000) throw error(429, '请稍后再查询认证结果。');
    refreshing.add(id); item.checkedAt = Date.now();
    try {
      const result = await ark.getVerification(item.token);
      if (!result.GroupId) throw error(409, '尚未取得真人素材组，请本人完成 H5 认证后再查询。');
      const group = await ark.getGroup(result.GroupId);
      if (group?.GroupType !== 'LivenessFace' || group.ProjectName !== ark.config.project) throw error(409, '认证返回的素材组不属于当前项目的真人人像库，已阻止入库。');
      item.groupId = result.GroupId; item.verifiedAt = new Date().toISOString();
      delete item.error; delete item.h5Url; delete item.token; save();
      return publicVerification(item);
    } catch (failure) { item.error = redact(failure.message); save(); throw failure; }
    finally { refreshing.delete(id); }
  }
  async function enroll(item, verification) {
    try {
      if (!item.sourceFileId) {
        const uploaded = await ark.uploadFile(resolvePath(item), item.name, item.type);
        item.sourceFileId = uploaded.id;
        persistAssets();
      }
      let assetUrl;
      for (let attempt = 0; attempt < 15; attempt++) {
        const file = await ark.getFile(item.sourceFileId);
        if (['error', 'failed'].includes(file.status)) throw new Error('方舟 Files API 文件处理失败，请重新上传素材。');
        if (file.download_url && ['active', 'processed', 'uploaded'].includes(file.status)) { assetUrl = file.download_url; break; }
        await wait(1000);
      }
      if (!assetUrl) throw new Error('尚未取得方舟文件下载地址，请稍后重新提交。');
      const group = await ark.getGroup(verification.groupId);
      if (group?.GroupType !== 'LivenessFace' || group.ProjectName !== ark.config.project) throw new Error('真人素材组校验失败，文件未提交入库。');
      item.enrollmentState = 'submitting'; item.status = '正在提交真人人像库'; persistAssets();
      item.assetId = await ark.createPortrait({ groupId: verification.groupId, assetUrl, name: item.name.slice(0, 64), assetType: item.type.startsWith('image/') ? 'Image' : 'Video' });
      item.groupId = verification.groupId; item.project = ark.config.project; item.remoteStatus = 'Processing'; item.enrollmentState = 'submitted';
      item.checkedAt = 0; item.status = 'Processing · 真人素材审核中'; delete item.error;
    } catch (failure) {
      item.error = redact(failure.message);
      item.enrollmentState = item.enrollmentState === 'submitting' ? 'unknown' : 'failed';
      item.status = item.enrollmentState === 'unknown' ? '提交结果未确认 · 请先在控制台核实' : '入库失败 · 本机文件仍保留';
    } finally { enrolling.delete(item.id); persistAssets(); }
  }
  function submitAsset(id, body) {
    assertConfigured(); checkConsent(body);
    if (!ark.config.filesApiConfigured) throw error(400, '本机文件入库还需要配置 API Key 以临时托管文件。');
    const item = findAsset(id);
    if (!item || item.collection !== 'private-person' || !/^(image|video)\//.test(item.type)) throw error(400, '只能提交真人分类中的本机图片或视频。');
    const verification = verifications.find(record => record.id === body.verificationId && record.groupId && record.project === ark.config.project);
    if (!verification) throw error(400, '请先由素材本人完成真人认证并查询到素材组。');
    if (item.assetId || item.enrollmentState === 'unknown') throw error(409, '该素材已提交或提交结果未知，请先查询控制台，避免重复入库。');
    if (enrolling.has(id)) throw error(409, '该素材正在入库，请勿重复提交。');
    if (enrolling.size >= 2) throw error(429, '最多同时上传两份真人素材，请稍后再试。');
    enrolling.add(id);
    item.enrollmentState = 'uploading'; item.status = '正在上传方舟临时文件'; item.verificationId = verification.id; delete item.error; persistAssets();
    setImmediate(() => void enroll(item, verification));
    return item;
  }
  return { createVerification, importGroup, refreshVerification, submitAsset, list: () => verifications.filter(item => item.project === ark.config.project).map(item => publicVerification(item, true)), busy: id => enrolling.has(id) };
}
