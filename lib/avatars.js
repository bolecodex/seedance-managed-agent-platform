import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const error = (status, message) => Object.assign(new Error(message), { status });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assetTypes = { image: 'Image', video: 'Video', audio: 'Audio' };

export function createAvatarLibrary({ ark, getAssets, persistAssets, resolvePath, redact }) {
  const enrolling = new Set();
  const pending = [];
  let active = 0;
  const preparing = new Map();
  function validate(body) {
    if (!ark.config.avatarLibraryConfigured) throw error(400, '虚拟人像素材库需要在服务端配置 AK/SK。');
    if (body.consent !== true && body.synthetic !== true) throw error(400, '请确认拥有素材使用权限，并同意提交 AIGC 人像库审核。');
    if (body.portraitType !== undefined && !['virtual', 'real'].includes(body.portraitType)) throw error(400, '人像来源标记仅支持 virtual 或 real。');
    if (body.groupId !== undefined && (typeof body.groupId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(body.groupId))) throw error(400, '素材组 ID 格式无效。');
    if (enrolling.size >= 100) throw error(429, '入库队列已满，请等待当前提交完成。');
  }
  function drain() {
    while (active < 2 && pending.length) {
      active++;
      const job = pending.shift();
      void enroll(job.item, job.destination, job.sourceUrl).finally(() => { active--; drain(); });
    }
  }
  function start(item, body, sourceUrl) {
    enrolling.add(item.id);
    item.project = ark.config.project;
    item.assetGroupType = 'AIGC';
    const portraitType = body.portraitType || item.portraitType || (item.collection === 'private-person' ? 'real' : body.synthetic === true ? 'virtual' : undefined);
    if (portraitType) { item.portraitType = portraitType; item.synthetic = portraitType === 'virtual'; }
    item.enrollmentState = 'uploading';
    item.status = '已排队 · 等待虚拟素材入库';
    delete item.error;
    persistAssets();
    pending.push({ item, destination: body.groupId, sourceUrl });
    setImmediate(drain);
    return item;
  }
  async function enroll(item, destination, sourceUrl) {
    try {
      item.status = sourceUrl ? '正在准备虚拟素材入库' : '正在上传方舟临时文件';
      item.groupId = await ark.prepareVirtualGroup(destination);
      persistAssets();
      let assetUrl = sourceUrl;
      if (!assetUrl) {
        if (!item.sourceFileId && item.arkFileId) item.sourceFileId = item.arkFileId;
        if (!item.sourceFileId) {
          const uploaded = await ark.uploadFile(resolvePath(item), item.name, item.type);
          item.sourceFileId = uploaded.id;
          persistAssets();
        }
        for (let attempt = 0; attempt < 30; attempt++) {
          const file = await ark.getFile(item.sourceFileId);
          if (['error', 'failed'].includes(file.status)) throw new Error('方舟临时文件处理失败。');
          if (file.download_url && ['active', 'processed', 'uploaded'].includes(file.status)) { assetUrl = file.download_url; break; }
          await wait(1000);
        }
        if (!assetUrl) throw new Error('尚未取得临时文件下载地址，请稍后重试入库。');
      }
      item.enrollmentState = 'submitting';
      item.status = '正在提交虚拟人像素材库';
      persistAssets();
      const remote = await ark.createAvatar({ groupId: item.groupId, name: item.name.slice(0, 64), assetUrl, assetType: assetTypes[item.type.split('/')[0]] });
      item.assetId = remote.assetId;
      item.groupId = remote.groupId;
      item.remoteStatus = 'Processing';
      item.enrollmentState = 'submitted';
      item.status = 'Processing · 方舟审核中';
      item.checkedAt = 0;
      delete item.error;
    } catch (failure) {
      item.error = redact(failure.message);
      item.enrollmentState = item.enrollmentState === 'submitting' ? 'unknown' : 'failed';
      item.status = item.enrollmentState === 'unknown' ? '提交结果未确认 · 请在控制台核实' : '入库失败 · 可查看详情后重试';
    } finally { enrolling.delete(item.id); persistAssets(); }
  }
  function submitAsset(id, body) {
    validate(body);
    if (!ark.config.filesApiConfigured) throw error(400, '本地文件入库需要 API Key 以临时托管文件。');
    const item = getAssets().find(record => record.id === id);
    if (!item || !['reference', 'private-person', 'virtual-avatar'].includes(item.collection) || !item.localPath || !assetTypes[item.type.split('/')[0]]) throw error(400, '请选择本机已保存的图片、视频或音频。');
    if (item.type.startsWith('image/') && item.size >= 30 * 1024 * 1024) throw error(413, '人像图片需小于 30 MB。');
    if (item.assetId || ['uploading', 'submitting', 'unknown'].includes(item.enrollmentState) || enrolling.has(id)) throw error(409, '该素材已提交、正在提交或结果未知，请先核实状态。');
    return start(item, body);
  }
  function submitUrl(body) {
    validate(body);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64 || !Object.values(assetTypes).includes(body.assetType)) throw error(400, '需要素材名称（最多 64 字）和 Image / Video / Audio 类型。');
    let source;
    try { source = new URL(body.assetUrl); } catch { throw error(400, '请输入可公开访问的素材 URL。'); }
    if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || source.href.length > 4096 || ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw error(400, '素材 URL 必须是云端可访问的 HTTP(S) 地址。');
    const item = { id: crypto.randomUUID(), name: body.name.trim(), type: `${body.assetType.toLowerCase()}/*`, size: 0, collection: 'virtual-avatar', createdAt: new Date().toISOString() };
    getAssets().unshift(item);
    return start(item, body, source.href);
  }
  async function sync(groupId, nextToken) {
    const result = await ark.listVirtualAssets(groupId, nextToken);
    const records = Array.isArray(result.Items) ? result.Items : [];
    for (const remote of records) {
      if (!remote.Id || remote.GroupId !== groupId || remote.ProjectName !== ark.config.project || !Object.values(assetTypes).includes(remote.AssetType)) continue;
      let item = getAssets().find(record => record.assetId === remote.Id && record.project === ark.config.project && record.collection === 'virtual-avatar');
      if (!item) { item = { id: crypto.randomUUID(), size: 0, collection: 'virtual-avatar', createdAt: remote.CreateTime || new Date().toISOString() }; getAssets().push(item); }
      Object.assign(item, { name: remote.Name || item.name || remote.Id, type: `${remote.AssetType.toLowerCase()}/*`, assetId: remote.Id, groupId, project: remote.ProjectName, remoteStatus: remote.Status, enrollmentState: 'submitted', checkedAt: Date.now(), status: { Active: 'Active · 审核通过', Processing: 'Processing · 方舟处理中', Failed: 'Failed · 方舟审核失败' }[remote.Status] || remote.Status });
      if (remote.Status === 'Failed') item.error = '方舟预处理或审核未通过，请在控制台查看详情。';
      else delete item.error;
    }
    persistAssets();
    return { count: records.length, nextToken: result.NextToken || null };
  }
  async function prepareReference(id, progress, portraitType) {
    if (preparing.has(id)) return preparing.get(id);
    const operation = (async () => {
      const item = getAssets().find(record => record.id === id);
      if (!item || !assetTypes[item.type.split('/')[0]]) throw error(400, '只能将已添加的图片、视频或音频提交人像素材库。');
      if (item.assetId && item.project !== ark.config.project) throw error(409, '素材资产所属项目与当前生成项目不一致。');
      if (!item.assetId && !enrolling.has(id)) {
        validate({ consent: true, portraitType });
        if (['uploading', 'submitting'].includes(item.enrollmentState)) throw error(409, '该素材正在提交，请等待现有入库完成，避免重复上传。');
        if (item.enrollmentState === 'unknown') throw error(409, '素材上次入库提交结果未确认，请先在控制台核实，避免重复入库。');
        if (!item.localPath || !ark.config.filesApiConfigured) throw error(400, '入库需要本机原始素材及已配置的 Files API。');
        if (item.type.startsWith('image/') && item.size >= 30 * 1024 * 1024) throw error(413, '虚拟人像图片需小于 30 MB。');
        start(item, { consent: true, portraitType });
      }
      while (enrolling.has(id)) { progress?.(`${item.name}：${item.status}`); await sleep(500); }
      if (!item.assetId) throw error(502, item.error || `${item.name} 入库未完成。`);
      const deadline = Date.now() + 30 * 60 * 1000;
      while (true) {
        const remote = await ark.getAvatar(item.assetId);
        if (remote.Id !== item.assetId || remote.ProjectName !== ark.config.project || remote.GroupId !== item.groupId) throw error(409, '平台返回的素材 ID、素材组或项目不匹配，未用于生成。');
        item.remoteStatus = remote.Status;
        item.checkedAt = Date.now();
        item.status = { Active: 'Active · 审核通过', Processing: 'Processing · 方舟处理中', Failed: 'Failed · 方舟审核失败' }[remote.Status] || remote.Status;
        delete item.error;
        if (remote.Status === 'Failed') item.error = '方舟未通过该素材的预处理或审核，请查看控制台具体原因。';
        persistAssets();
        progress?.(`${item.name}：${item.status}`);
        if (remote.Status === 'Active') return { ...item };
        if (remote.Status !== 'Processing') throw error(409, item.error || `素材暂不可用：${remote.Status || '未知状态'}`);
        if (Date.now() >= deadline) throw error(504, '素材仍在平台审核中，资产 ID 已保留；稍后继续会查询同一资产，不会重复入库。');
        await sleep(3000);
      }
    })();
    preparing.set(id, operation);
    try { return await operation; } finally { preparing.delete(id); }
  }
  async function prepareReferences(ids, { progress, signal, portraitType } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw error(400, '请提供 1–20 份不重复的已添加素材 ID。');
    const ready = [];
    for (const id of ids) {
      signal?.throwIfAborted();
      // Enrollment survives a local pause. Persist its ID and reuse the same
      // operation on resume instead of creating a second cloud asset.
      const operation = prepareReference(id, progress, portraitType);
      if (!signal) { ready.push(await operation); continue; }
      let abort;
      try {
        ready.push(await Promise.race([operation, new Promise((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })]));
      } finally { signal.removeEventListener('abort', abort); }
    }
    return ready;
  }
  return { submitAsset, submitUrl, sync, prepareReferences, busy: id => enrolling.has(id) || preparing.has(id) };
}
