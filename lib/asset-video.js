import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';

export const assetVideoToolName = 'generate_video_with_assets';
export const assetVideoDefinition = {
  type: 'custom', name: assetVideoToolName,
  description: '使用已审核的私域人像 asset:// URI 和普通场景参考图直接调用 Seedance 视频 API，绕开 GenVideo 只接收本地文件的工具限制。人物入库 Active 后优先使用此工具；保留完整原提示词及参考素材顺序。返回真实视频任务与下载地址，不会重画人物。',
  input_schema: {
    type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, description: '完整最终视频提示词，按图片1、图片2等引用素材，保留原时间轴与人物要求。' },
      asset_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, uniqueItems: true, description: '按最终请求的全部参考素材顺序传入本机素材 ID，包括普通场景图及已入库人物图。' },
      duration: { type: 'integer', minimum: 2, maximum: 30 },
      ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3'] },
      resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
      generate_audio: { type: 'boolean', description: '需要画内对白与动作音效时为 true，是否配乐由提示词约束。' },
      output_path: { type: 'string', description: '期望的 /mnt/session/outputs/ 下 mp4 文件路径，工具返回下载 URL 后请保存到此路径。' }
    }, required: ['prompt', 'asset_ids', 'duration', 'ratio', 'resolution', 'generate_audio', 'output_path'], additionalProperties: false
  }
};

export async function generateAssetVideo({ ark, task, callId, input, items, progress, signal }) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || !Number.isInteger(input.duration) || input.duration < 2 || input.duration > 30 || !['1:1', '16:9', '9:16', '4:3'].includes(input.ratio) || !['480p', '720p', '1080p'].includes(input.resolution) || typeof input.generate_audio !== 'boolean' || typeof input.output_path !== 'string' || !/^\/mnt\/session\/outputs\/(?!.*(?:\/\.\.?\/|\/\/$))[^\x00-\x1f]+\.mp4$/.test(input.output_path) || input.output_path.split('/').some(segment => ['.', '..'].includes(segment))) throw new Error('需要完整提示词、2–30 秒时长、画面比例、分辨率、音轨选项和 outputs 下有效的 mp4 路径。');
  task.assetVideoJobs ||= {};
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ prompt: input.prompt, assetIds: items.map(item => [item.id, item.assetId || item.arkFileId]), duration: input.duration, ratio: input.ratio, resolution: input.resolution, audio: input.generate_audio })).digest('hex');
  let job = task.assetVideoJobs[callId] || Object.values(task.assetVideoJobs).find(item => item.fingerprint === fingerprint);
  if (job) task.assetVideoJobs[callId] = job;
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
    if (!hasPortrait) throw new Error('此工具用于含已入库人像的生成，请先完成 prepare_portrait_assets。');
    const model = await ark.videoModel(task);
    signal.throwIfAborted();
    job = task.assetVideoJobs[callId] = { status: 'submitting', model, fingerprint, createdAt: new Date().toISOString(), outputPath: input.output_path };
    progress('正在使用已审核人像提交 Seedance 视频生成。');
    try {
      // Preserve an accepted ID even if the local task is paused in flight.
      const remote = await ark.createVideo({ model, content, duration: input.duration, ratio: input.ratio, resolution: input.resolution, generate_audio: input.generate_audio, watermark: true });
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
      job.file = { id: job.id, filename: job.outputPath, mime_type: 'video/mp4', download_url: url, provider: 'seedance-assets' };
      job.completedAt = new Date().toISOString();
      progress('已生成真实视频，正在交给 Agent 保存与验收。');
      break;
    }
    if (['failed', 'cancelled', 'expired'].includes(remote.status)) throw new Error(`Seedance 视频任务 ${job.id} ${remote.status}：${remote.error?.message || remote.error?.code || '请查看控制台详情。'}`);
    await sleep(3000, undefined, { signal });
  }
  return { status: 'succeeded', task_id: job.id, video_url: job.file.download_url, output_path: job.outputPath, instruction: '视频已由 Seedance API 实际生成。请将 video_url 下载到 output_path，用 ffprobe 核实实际时长与尺寸，并交付该真实 mp4；无需重新调用 GenVideo。' };
}
