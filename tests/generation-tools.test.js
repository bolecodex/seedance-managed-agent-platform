import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerationTools, imageToolName, videoToolName } from '../lib/generation-tools.js';
import { mockArk, startServer, until } from './helpers/server.js';

const imageInput = { prompt: 'A quiet sea without watermarks', size: '2048x2048', output_path: '/mnt/session/outputs/sea.jpg' };
const videoInput = { prompt: 'Sunrise at sea without watermarks', duration: 5, ratio: '16:9', resolution: '720p', generate_audio: false, output_path: '/mnt/session/outputs/sea.mp4' };
function setup() {
  const requests = [];
  const ark = {
    imageModel: async () => 'test-seedream', videoModel: async () => 'test-seedance',
    createImage: async body => { requests.push(body); return { data: [{ url: 'https://files.test/sea.jpg' }] }; },
    createVideo: async body => { requests.push(body); return { id: 'video-1', status: 'queued' }; },
    getVideo: async () => ({ status: 'succeeded', content: { video_url: 'https://files.test/sea.mp4' } }),
    getFile: async () => ({ status: 'active', download_url: 'https://files.test/reference.jpg' })
  };
  const asset = { id: 'reference', collection: 'reference', type: 'image/jpeg', name: 'Reference', arkFileId: 'file-1' };
  const tool = createGenerationTools({ ark, getAssets: () => [asset], redact: text => text });
  const task = { messages: [{ role: 'user', delivery: 'sent', assetIds: [asset.id] }] };
  const execute = (name, input, id = 'call1') => tool.execute(task, input, () => {}, new AbortController().signal, { id, name });
  return { ark, requests, task, execute };
}

test('image generation sends watermark=false and equivalent calls reuse the actual result', async () => {
  const { execute, requests, task } = setup();
  const result = await execute(imageToolName, imageInput);
  assert.equal(result.image_url, 'https://files.test/sea.jpg');
  assert.deepEqual(requests[0], { model: 'test-seedream', prompt: imageInput.prompt, size: imageInput.size, response_format: 'url', watermark: false });
  assert.equal((await execute(imageToolName, imageInput, 'call2')).image_url, result.image_url);
  assert.equal(task.imageGenerationJobs.call1.status, 'succeeded');
  assert.equal(requests.length, 1);
});

test('reference images preserve their order and undeclared files fail before generation', async () => {
  const { execute, requests } = setup();
  await execute(imageToolName, { ...imageInput, asset_ids: ['reference'], reference_image_urls: ['https://files.test/previous.jpg'] });
  assert.deepEqual(requests[0].image, ['https://files.test/reference.jpg', 'https://files.test/previous.jpg']);
  await assert.rejects(execute(imageToolName, { ...imageInput, asset_ids: ['unknown'] }, 'bad'), /本会话/);
  await assert.rejects(execute(imageToolName, { ...imageInput, output_path: '/mnt/session/outputs/../secret.jpg' }, 'bad'), /有效尺寸/);
  assert.equal(requests.length, 1);
});

test('lost image responses are persisted and are never submitted twice', async () => {
  const { execute, requests, task, ark } = setup();
  ark.createImage = async body => { requests.push(body); throw new Error('connection lost'); };
  await assert.rejects(execute(imageToolName, imageInput), /connection lost/);
  assert.equal(task.imageGenerationJobs.call1.status, 'unknown');
  await assert.rejects(execute(imageToolName, imageInput, 'call2'), /结果未确认/);
  assert.equal(requests.length, 1);
});

test('text-only video generation disables watermarks without requiring portrait assets', async () => {
  const { execute, requests } = setup();
  const result = await execute(videoToolName, videoInput);
  assert.equal(result.video_url, 'https://files.test/sea.mp4');
  assert.equal(requests[0].watermark, false);
  assert.deepEqual(requests[0].content, [{ type: 'text', text: videoInput.prompt }]);
});

test('generated images can be used as video frames and remote references are part of job identity', async () => {
  const { execute, requests } = setup();
  const frame = { type: 'image', url: 'https://files.test/sea.jpg', role: 'first_frame' };
  await execute(videoToolName, { ...videoInput, reference_media: [frame] });
  assert.deepEqual(requests[0].content[1], { type: 'image_url', image_url: { url: frame.url }, role: 'first_frame' });
  await execute(videoToolName, { ...videoInput, reference_media: [{ ...frame, url: 'https://files.test/other.jpg' }] }, 'call2');
  assert.equal(requests.length, 2);
  await assert.rejects(execute(videoToolName, { ...videoInput, reference_media: [{ ...frame, type: 'audio' }] }, 'bad'), /匹配的模态/);
});

test('a live Session exposes both tools and returns real image and video outputs with watermarks disabled', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, {
    ARK_API_KEY: 'test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment',
    ARK_IMAGE_MODEL: 'test-seedream', ARK_VIDEO_MODEL: 'test-seedance', ARK_BASE_URL: ark.baseUrl
  });
  const { task } = await request('/api/creative', { prompt: 'Create an image and video of the sea' });
  const session = await until(() => [...ark.sessions.values()].find(item => item.submissions === 1));
  assert.ok(session.agent.tools.some(tool => tool.name === imageToolName));
  assert.ok(session.agent.tools.some(tool => tool.name === videoToolName));
  const builtins = session.agent.tools.find(tool => tool.type === 'agent_toolset_multimodal_20260825').configs;
  assert.equal(builtins.find(tool => tool.name === 'image_generate').enabled, true);
  assert.equal(builtins.find(tool => tool.name === 'image_generate').permission_policy.type, 'always_ask');
  assert.equal(builtins.find(tool => tool.name === 'video_generate').enabled, false);
  const builtin = ark.emit(session, { type: 'agent.tool_use', name: 'GenImage', input: { prompt: 'A quiet sea' }, evaluated_permission: 'ask' });
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [builtin.id] } });
  await until(() => session.confirmations.length === 1);
  assert.equal(session.confirmations[0].result, 'deny');
  assert.match(session.confirmations[0].deny_message, /generate_image_without_watermark/);
  for (const [name, input] of [[imageToolName, imageInput], [videoToolName, videoInput]]) {
    const count = session.customResults.length;
    const call = ark.emit(session, { type: 'agent.custom_tool_use', name, input });
    session.status = 'idle';
    ark.emit(session, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [call.id] } });
    await until(() => session.customResults.length === count + 1);
    assert.equal(session.customResults.at(-1).is_error, false);
  }
  assert.equal(ark.imageRequests[0].watermark, false);
  assert.equal(ark.videoRequests[0].watermark, false);
  ark.finish(session);
  const done = await until(async () => { const { task: value } = await request(`/api/tasks/${task.id}`); return value.status === 'completed' && value; });
  assert.ok(done.files.some(file => file.download_url === 'https://files.test/generated.jpg'));
  assert.ok(done.files.some(file => file.download_url === 'https://files.test/generated.mp4'));
  assert.equal(session.submissions, 1);
});
