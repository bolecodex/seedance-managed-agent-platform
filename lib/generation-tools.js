import crypto from 'node:crypto';
import { assetVideoDefinition, generateAssetVideo } from './asset-video.js';

export const imageToolName = 'generate_image_without_watermark';
export const videoToolName = 'generate_video_without_watermark';
const assetIds = { type: 'array', items: { type: 'string' }, maxItems: 20, uniqueItems: true, description: '按引用顺序传入本会话已添加的本机素材 ID；纯文字生成时省略。' };
export const generationDefinitions = [
  {
    type: 'custom', name: imageToolName,
    description: '直接调用图片生成 API 并强制 watermark=false，生成无平台可见水印的图片。支持文生图或引用本会话图片；返回真实下载 URL，随后保存并检查画面。',
    input_schema: {
      type: 'object', properties: {
        prompt: { type: 'string', minLength: 1, description: '完整图片提示词，保留主体、构图、画幅及用户要求的文字，要求无水印。' },
        asset_ids: { ...assetIds, maxItems: 14 },
        reference_image_urls: { type: 'array', items: { type: 'string' }, maxItems: 14, description: '可选的云端 HTTPS 图片 URL，可引用本工具之前生成的图片；与 asset_ids 合计最多 14 张。' },
        size: { type: 'string', description: '当前图片模型支持的分辨率或明确宽高，例如 2K、2048x2048。' },
        output_path: { type: 'string', description: '/mnt/session/outputs/ 下的 .jpg 或 .jpeg 路径。' }
      }, required: ['prompt', 'size', 'output_path'], additionalProperties: false
    }
  },
  {
    ...assetVideoDefinition, name: videoToolName,
    description: '直接调用视频生成 API 并强制 watermark=false。支持文生视频、普通图片/视频/音频参考和已审核人像资产；返回真实任务及视频 URL，暂停后复用原任务。',
    input_schema: {
      ...assetVideoDefinition.input_schema,
      properties: {
        ...assetVideoDefinition.input_schema.properties, asset_ids: assetIds,
        reference_media: { type: 'array', maxItems: 20, description: '可选 HTTPS 参考素材，可使用刚生成的图片 URL。按顺序放在 asset_ids 素材之后；图生视频首帧设 role=first_frame。', items: { type: 'object', properties: { type: { type: 'string', enum: ['image', 'video', 'audio'] }, url: { type: 'string' }, role: { type: 'string', enum: ['reference_image', 'first_frame', 'last_frame', 'reference_video', 'reference_audio'] } }, required: ['type', 'url'], additionalProperties: false } }
      },
      required: assetVideoDefinition.input_schema.required.filter(name => name !== 'asset_ids')
    }
  }
];

function outputPath(value) {
  return typeof value === 'string' && /^\/mnt\/session\/outputs\/[^\x00-\x1f]+\.jpe?g$/i.test(value) && !value.slice(1).split('/').some(segment => !segment || segment === '.' || segment === '..');
}

export function createGenerationTools({ ark, getAssets, redact }) {
  return {
    version: 1,
    definitions: generationDefinitions,
    instructions: `图片生成优先调用 ${imageToolName}，普通视频生成优先调用 ${videoToolName}，含已审核人物的视频也可用 generate_video_with_assets；这些工具由服务端强制 watermark=false，不能改用带水印的默认生成。参考素材 ID 来自本会话清单；先完成人像入库要求。图片参考可传 asset_ids 或已生成的 HTTPS 图片 URL。必须传完整提示词，取得真实结果后下载到 output_path 并验收。若当前需求超出这些工具参数范围，只能使用已确认支持无水印的其他工具，不要静默改用默认带水印接口。`,
    async execute(task, input, progress, signal, call) {
      input ||= {};
      const ids = input.asset_ids || [];
      const allowed = new Set((task.messages || []).filter(message => message.role === 'user' && message.delivery === 'sent').flatMap(message => message.assetIds || []));
      if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(ids).size !== ids.length) throw new Error('只能引用本会话已发送消息中添加的不重复素材 ID。');
      const items = ids.map(id => getAssets().find(item => item.id === id));
      if (items.some(item => !item)) throw new Error('参考素材已被删除，请重新添加。');
      if (call?.name === videoToolName) {
        const remoteReferences = input.reference_media || [];
        if (!Array.isArray(remoteReferences) || remoteReferences.length + items.length > 20 || remoteReferences.some(item => !item || !['image', 'video', 'audio'].includes(item.type) || typeof item.url !== 'string' || !item.url.startsWith('https://') || item.role !== undefined && ![`reference_${item.type}`, ...(item.type === 'image' ? ['first_frame', 'last_frame'] : [])].includes(item.role))) throw new Error('视频参考素材需要匹配的模态、角色和 HTTPS URL，全部参考素材最多 20 份。');
        return generateAssetVideo({ ark, task, callId: call.id, input, items, progress, signal, requirePortrait: false, remoteReferences });
      }
      if (call?.name !== imageToolName) throw new Error('未知生成工具。');
      const urls = input.reference_image_urls || [];
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || !/^(?:auto|[1-4](?:\.5)?K|[1-9]\d{2,3}x[1-9]\d{2,3})$/.test(input.size) || !outputPath(input.output_path) || !Array.isArray(urls) || urls.some(url => typeof url !== 'string' || !url.startsWith('https://')) || urls.length + items.length > 14) throw new Error('需要完整图片提示词、有效尺寸、outputs 下的 jpg 路径及最多 14 张 HTTPS 图片参考。');
      task.imageGenerationJobs ||= {};
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ prompt: input.prompt, size: input.size, references: items.map(item => [item.id, item.arkFileId]), urls })).digest('hex');
      let job = task.imageGenerationJobs[call.id] || Object.values(task.imageGenerationJobs).find(item => item.fingerprint === fingerprint);
      if (job) task.imageGenerationJobs[call.id] = job;
      if (!job) {
        const references = [];
        for (const item of items) {
          signal.throwIfAborted();
          if (!item.type?.startsWith('image/') || item.collection !== 'reference' || !item.arkFileId) throw new Error(`${item.name} 需为已同步的普通参考图片。`);
          const file = await ark.getFile(item.arkFileId);
          if (!file.download_url?.startsWith('https://') || !['active', 'processed', 'uploaded'].includes(file.status)) throw new Error(`${item.name} 尚无可用的参考图片地址。`);
          references.push(file.download_url);
        }
        references.push(...urls);
        const model = await ark.imageModel(task);
        signal.throwIfAborted();
        job = task.imageGenerationJobs[call.id] = { status: 'submitting', model, fingerprint, outputPath: input.output_path, createdAt: new Date().toISOString() };
        progress('正在提交无水印图片生成。');
        try {
          // Complete this bounded request even when paused, retaining any accepted result.
          const result = await ark.createImage({ model, prompt: input.prompt, size: input.size, response_format: 'url', ...(references.length ? { image: references.length === 1 ? references[0] : references } : {}), watermark: false });
          const image = result.data?.[0];
          if (!image?.url?.startsWith('https://')) throw new Error(result.error?.message || image?.error?.message || '图片生成未返回可用下载地址，请先核实结果，不会自动重复生成。');
          job.file = { id: `image-${crypto.randomUUID()}`, filename: job.outputPath, mime_type: 'image/jpeg', download_url: image.url, provider: 'seedream' };
          job.status = 'succeeded'; job.completedAt = new Date().toISOString();
          progress('已生成真实图片，正在交给 Agent 保存与验收。');
        } catch (failure) { job.status = failure.status ? 'rejected' : 'unknown'; progress('图片提交结果已记录。'); throw failure; }
      }
      if (!job.file) throw new Error('上次图片提交结果未确认，请先核实，不会自动重复生成。');
      return { status: 'succeeded', image_url: job.file.download_url, output_path: job.outputPath, instruction: '请将 image_url 下载到 output_path，检查画幅、主体与四角无可见水印后交付真实图片；无需再次生成。' };
    },
    safeError: failure => redact(failure.message)
  };
}
