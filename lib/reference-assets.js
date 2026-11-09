import { assetVideoDefinition, assetVideoToolName, generateAssetVideo } from './asset-video.js';

export const portraitGuide = 'https://docs.volcengine.com/docs/82379/2333565?lang=zh';
export const portraitToolName = 'prepare_portrait_assets';
export const portraitInstructions = `人物参考素材工作流（${portraitGuide}）：先查看本会话添加的所有图片和视频。凡图片或视频中包含真人、写实人物、人脸或虚拟角色，都必须先调用 ${portraitToolName}，统一提交当前项目的 GroupType=AIGC 素材库；视频必须作为 Video 类型入库，不能只入库同一人物的图片而漏掉视频。等待每份素材返回 Active 后，再用对应的 asset:// URI 生成视频。普通 Files 上传与原图路径不代表已经入库。本项目不按真人或虚拟角色分流，不把 H5 本人认证或 LivenessFace 素材组作为此流程的前置条件。portrait_type 只记录来源，不影响 AIGC 入库；不得把真人素材标记为虚构或 synthetic。使用原始素材，如实保留平台审核结果；审核失败时说明具体原因，不以更换类型、重编码、降采样或重画人物规避审核。不包含人物的场景、产品与文档保持普通参考素材。保留全部素材在用户输入中的顺序，提示词使用“图片 1 / 视频 1 / 音频 1”指代；图片 asset:// 使用 image_url，视频 asset:// 使用 video_url，音频 asset:// 使用 audio_url，不得把视频当图片传递。遇到 InputImageSensitiveContentDetected.PrivacyInformation 时，立即调用入库工具，不要直接结束并要求用户换图。入库成功后继续原需求，不改变人物身份、风格、时长或分镜。`;

export function createReferenceAssetTool({ avatars, ark, getAssets, project, redact }) {
  return {
    version: 4,
    instructions: `${portraitInstructions}\n人物图片和视频均入库后，立即调用 ${assetVideoToolName} 生成视频，传入完整最终提示词及按原顺序的全部本机素材 ID。该工具会将审核通过的 asset:// 按原始模态放入视频 API 的 content.<模态>_url.url 字段：图片 image_url、视频 video_url、音频 audio_url，并保留普通场景素材。GenVideo 的 ref_images 只接受本地文件，不支持 asset://；不要对 asset:// 查找本地文件、重新下载或反复尝试 GenVideo。`,
    extraDefinitions: [assetVideoDefinition],
    definition: {
      type: 'custom', name: portraitToolName,
      description: `将本次会话已添加的真人或虚拟角色原始图片及视频统一提交当前项目 AIGC 库审核；视频按 Video 类型入库。等待 Active 后返回与图片 / 视频模态对应、可用于生成的 asset:// URI。人物视频生成前或遇到 PrivacyInformation 时立即调用，不要求先完成 H5 本人认证。${portraitGuide}。入库是否通过以平台返回为准。`,
      input_schema: {
        type: 'object', properties: {
          asset_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, uniqueItems: true, description: '按原引用顺序提供消息中列出的本机素材 ID；不填文件路径或云端 Asset ID。' },
          portrait_type: { type: 'string', enum: ['virtual', 'real'], description: '可选的来源标记：虚构或 AI 角色填 virtual，真人填 real。不影响 AIGC 入库，不确定时省略。' }
        }, required: ['asset_ids'], additionalProperties: false
      }
    },
    context(task) {
      const ids = [...new Set(task.messages.filter(message => message.role === 'user' && ['sending', 'sent'].includes(message.delivery)).flatMap(message => message.assetIds || []))];
      const counters = { image: 0, video: 0, audio: 0 };
      return ids.map(id => getAssets().find(item => item.id === id)).filter(item => item && /^(image|video|audio)\//.test(item.type)).map(item => {
        const modality = item.type.split('/')[0];
        const uri = item.assetId && item.remoteStatus === 'Active' && item.project === project ? `；已审核 URI=asset://${item.assetId}` : '';
        return `${{ image: '图片', video: '视频', audio: '音频' }[modality]} ${++counters[modality]}：${item.name}；本机素材 ID=${item.id}${uri}`;
      }).join('\n');
    },
    async execute(task, input, progress, signal, call) {
      const ids = input?.asset_ids;
      const allowed = new Set(task.messages.filter(message => message.role === 'user' && message.delivery === 'sent').flatMap(message => message.assetIds || []));
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(ids).size !== ids.length) throw new Error('只能入库本会话已发送消息中明确添加的 1–20 份不重复素材。');
      if (call?.name === assetVideoToolName) {
        const items = ids.map(id => getAssets().find(item => item.id === id));
        if (items.some(item => !item)) throw new Error('参考素材已被删除，请重新添加。');
        return generateAssetVideo({ ark, task, callId: call.id, input, items, progress, signal });
      }
      if (input.portrait_type !== undefined && !['virtual', 'real'].includes(input.portrait_type)) throw new Error('人像来源标记仅支持 virtual 或 real，不确定时可省略。');
      const items = await avatars.prepareReferences(ids, { progress, signal, portraitType: input.portrait_type });
      return {
        project, status: 'Active', guide: portraitGuide,
        references: items.map(item => ({ local_asset_id: item.id, name: item.name, modality: item.type.split('/')[0], uri: `asset://${item.assetId}`, role: `reference_${item.type.split('/')[0]}` })),
        instruction: '请立即调用 generate_video_with_assets，传入完整原提示词及包括含人物的视频和场景素材在内的全部本机素材 ID，按原引用顺序生成。工具会把图片、视频、音频 asset:// 分别按 image_url、video_url、audio_url 模态使用；不要漏掉已入库的人物视频，也不要交给只支持本地路径的 GenVideo，或重新传入原图、下载后重编码。提示词中的素材编号须与最终请求顺序一致。'
      };
    },
    safeError: failure => redact(failure.message)
  };
}
