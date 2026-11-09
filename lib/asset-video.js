import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';

export const assetVideoToolName = 'generate_video_with_assets';
export const assetVideoDefinition = {
  type: 'custom', name: assetVideoToolName,
  description: '使用已审核的私域人物图片 / 视频 asset:// URI 和普通场景参考素材直接调用 Seedance 视频 API，绕开 GenVideo 只接收本地文件的工具限制。图片、视频、音频资产均按原模态传入；含人物的视频也必须先以 Video 类型入库并等待 Active。保留完整原提示词及素材顺序。返回真实视频、完整提示词 prompt 和平台任务 cgt_id，交付时逐段附上，不返回参考素材。',
  input_schema: {
    type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, description: '完整最终视频提示词，按图片1、视频1等原模态编号引用素材，保留原时间轴与人物要求。' },
      asset_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, uniqueItems: true, description: '按最终请求顺序传入全部参考素材本机 ID，包括已入库的人物视频、人物图片和普通场景素材。' },
      duration: { type: 'integer', minimum: 2, maximum: 30 },
      ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3'] },
      resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
      generate_audio: { type: 'boolean', description: '需要画内对白与动作音效时为 true，是否配乐由提示词约束。' },
      output_path: { type: 'string', description: '期望的 /mnt/session/outputs/ 下 mp4 文件路径，工具返回下载 URL 后请保存到此路径。' }
    }, required: ['prompt', 'asset_ids', 'duration', 'ratio', 'resolution', 'generate_audio', 'output_path'], additionalProperties: false
  }
};

export async function generateAssetVideo({ ark, task, callId, input, items, progress, signal, requirePortrait = true, remoteReferences = [] }) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || !Number.isInteger(input.duration) || input.duration < 2 || input.duration > 30 || !['1:1', '16:9', '9:16', '4:3'].includes(input.ratio) || !['480p', '720p', '1080p'].includes(input.resolution) || typeof input.generate_audio !== 'boolean' || typeof input.output_path !== 'string' || !/^\/mnt\/session\/outputs\/(?!.*(?:\/\.\.?\/|\/\/$))[^\x00-\x1f]+\.mp4$/.test(input.output_path) || input.output_path.split('/').some(segment => ['.', '..'].includes(segment))) throw new Error('需要完整提示词、2–30 秒时长、画面比例、分辨率、音轨选项和 outputs 下有效的 mp4 路径。');
  task.assetVideoJobs ||= {};
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ prompt: input.prompt, assetIds: items.map(item => [item.id, item.assetId || item.arkFileId]), duration: input.duration, ratio: input.ratio, resolution: input.resolution, audio: input.generate_audio, ...(remoteReferences.length ? { remoteReferences } : {}) })).digest('hex');
  let job = task.assetVideoJobs[callId] || Object.values(task.assetVideoJobs).find(item => item.fingerprint === fingerprint);
  if (job) {
    task.assetVideoJobs[callId] = job;
    if (!job.prompt && job.fingerprint === fingerprint) job.prompt = input.prompt;
  }
  if (!job) {
    const content = [{ type: 'text', text: input.prompt }];
    let hasPortrait = false;
    for (const item of items) {
      signal.throwIfAborted();
      const modality = item.type?.split('/')[0];
      if (!['image', 'video', 'audio'].includes(modality)) throw new Error('视频生成参考素材仅支持图片、视频和音频。');
      let url;
      if (item.assetId) {
        const remote = await ark.getAvatar(item.assetId);
        if (remote.Id !== item.assetId || remote.ProjectName !== ark.config.project || remote.GroupId !== item.groupId || remote.Status !== 'Active') throw new Error(`${item.name} 尚未通过当前项目的入库审核，请先调用 prepare_portrait_assets。`);
        url = `asset://${item.assetId}`; hasPortrait = true;
      } else {
        if (item.collection !== 'reference' || !item.arkFileId) throw new Error(`${item.name} 尚未上传或入库。`);
        const file = await ark.getFile(item.arkFileId);
        if (!file.download_url || !['active', 'processed', 'uploaded'].includes(file.status)) throw new Error(`${item.name} 尚无可用的参考文件地址。`);
        url = file.download_url;
      }
      content.push({ type: `${modality}_url`, [`${modality}_url`]: { url }, role: `reference_${modality}` });
    }
    if (requirePortrait && !hasPortrait) throw new Error('此工具用于含已入库人像的生成，请先完成 prepare_portrait_assets。');
    for (const item of remoteReferences) content.push({ type: `${item.type}_url`, [`${item.type}_url`]: { url: item.url }, role: item.role || `reference_${item.type}` });
    const model = await ark.videoModel(task);
    signal.throwIfAborted();
    job = task.assetVideoJobs[callId] = { status: 'submitting', model, fingerprint, prompt: input.prompt, createdAt: new Date().toISOString(), outputPath: input.output_path };
    progress(hasPortrait ? '正在使用已审核人像提交 Seedance 视频生成。' : '正在提交无水印 Seedance 视频生成。');
    try {
      // Preserve an accepted ID even if the local task is paused in flight.
      const remote = await ark.createVideo({ model, content, duration: input.duration, ratio: input.ratio, resolution: input.resolution, generate_audio: input.generate_audio, watermark: false });
      if (!remote.id) throw new Error('视频提交未返回任务 ID，请先到控制台核实，不会自动重发。');
      job.id = remote.id; job.status = remote.status || 'queued';
      progress('视频生成已提交，正在等待结果。');
    } catch (failure) { job.status = failure.status ? 'rejected' : 'unknown'; progress('视频提交结果已记录。'); throw failure; }
  }
  if (!job.id) throw new Error('上次视频提交结果未确认，请到控制台核实，不会自动重复生成。');
  while (!job.file) {
    signal.throwIfAborted();
    const remote = await ark.getVideo(job.id, signal);
    job.status = remote.status;
    progress(`Seedance 视频生成：${remote.status}。`);
    if (remote.status === 'succeeded') {
      const url = remote.content?.video_url;
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('平台标记成功但未返回可用的视频下载地址。');
      job.file = { id: job.id, filename: job.outputPath, mime_type: 'video/mp4', download_url: url, provider: 'seedance-assets', prompt: job.prompt, cgt_id: job.id };
      job.completedAt = new Date().toISOString();
      progress('已生成真实视频，正在交给 Agent 保存与验收。');
      break;
    }
    if (['failed', 'cancelled', 'expired'].includes(remote.status)) throw new Error(`Seedance 视频任务 ${job.id} ${remote.status}：${remote.error?.message || remote.error?.code || '请查看控制台详情。'}`);
    await sleep(3000, undefined, { signal });
  }
  job.file = { ...job.file, ...(job.prompt ? { prompt: job.prompt } : {}), cgt_id: job.id };
  return { status: 'succeeded', task_id: job.id, cgt_id: job.id, prompt: job.prompt, video_url: job.file.download_url, output_path: job.outputPath, instruction: '视频已由 Seedance API 实际生成。请将 video_url 下载到 output_path，用 ffprobe 核实实际时长与尺寸，并查看全片确认无可见水印。每次交付该视频都附上这里返回的完整 prompt 和 cgt_id（显示为 cgt-id），多段视频逐一对应；不附带参考素材文件、预览、链接或清单。无需重新调用 GenVideo。' };
}
