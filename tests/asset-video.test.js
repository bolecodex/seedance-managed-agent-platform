import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAssetVideo } from '../lib/asset-video.js';

const input = { prompt: '图片1教室，图片2虚构人物。', duration: 30, ratio: '9:16', resolution: '720p', generate_audio: true, output_path: '/mnt/session/outputs/final.mp4' };
const items = [
  { id: 'room', type: 'image/png', name: '教室', collection: 'reference', arkFileId: 'room-file' },
  { id: 'person', type: 'image/png', name: '人物', collection: 'reference', assetId: 'person-asset', groupId: 'person-group' }
];
function client() {
  const requests = [];
  const ark = {
    config: { project: 'test-project' },
    getAvatar: async () => ({ Id: 'person-asset', GroupId: 'person-group', ProjectName: 'test-project', Status: 'Active' }),
    getFile: async () => ({ status: 'active', download_url: 'https://files.test/room.png' }),
    videoModel: async () => 'seedance-test',
    createVideo: async body => { requests.push(body); return { id: 'video-1', status: 'queued' }; },
    getVideo: async () => ({ status: 'succeeded', content: { video_url: 'https://files.test/final.mp4' } })
  };
  return { ark, requests };
}

test('asset video requests preserve reference order, project validation and requested video settings', async () => {
  const { ark, requests } = client();
  const task = {};
  const result = await generateAssetVideo({ ark, task, callId: 'call1', input, items, progress() {}, signal: new AbortController().signal });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.prompt, input.prompt);
  assert.equal(result.cgt_id, result.task_id);
  assert.equal(task.assetVideoJobs.call1.file.prompt, input.prompt);
  assert.equal(task.assetVideoJobs.call1.file.cgt_id, result.task_id);
  assert.equal(result.references, undefined);
  assert.deepEqual(requests[0], { model: 'seedance-test', content: [
    { type: 'text', text: input.prompt },
    { type: 'image_url', image_url: { url: 'https://files.test/room.png' }, role: 'reference_image' },
    { type: 'image_url', image_url: { url: 'asset://person-asset' }, role: 'reference_image' }
  ], duration: 30, ratio: '9:16', resolution: '720p', generate_audio: true, watermark: false });
  const again = await generateAssetVideo({ ark, task, callId: 'call2', input, items, progress() {}, signal: new AbortController().signal });
  assert.equal(again.task_id, result.task_id);
  assert.equal(again.prompt, input.prompt);
  assert.equal(requests.length, 1);
});

test('a lost submission response is retained and an equivalent tool retry cannot create another video', async () => {
  const { ark, requests } = client();
  ark.createVideo = async body => { requests.push(body); throw new Error('connection lost'); };
  const task = {};
  const args = { ark, task, input, items, progress() {}, signal: new AbortController().signal };
  await assert.rejects(generateAssetVideo({ ...args, callId: 'call1' }), /connection lost/);
  assert.equal(task.assetVideoJobs.call1.status, 'unknown');
  await assert.rejects(generateAssetVideo({ ...args, callId: 'call2' }), /提交结果未确认/);
  assert.equal(requests.length, 1);
});

test('pending or mismatched portraits cannot enter a generation request', async () => {
  const { ark, requests } = client();
  ark.getAvatar = async () => ({ Id: 'person-asset', GroupId: 'person-group', ProjectName: 'other-project', Status: 'Active' });
  await assert.rejects(generateAssetVideo({ ark, task: {}, callId: 'call1', input, items, progress() {}, signal: new AbortController().signal }), /当前项目/);
  assert.equal(requests.length, 0);
});

test('video failure is reported without a fake file and a paused job resumes the same accepted task', async () => {
  const { ark, requests } = client();
  const task = {};
  const controller = new AbortController();
  ark.getVideo = async () => { controller.abort(new Error('paused')); throw controller.signal.reason; };
  const args = { ark, task, callId: 'call1', input, items, progress() {} };
  await assert.rejects(generateAssetVideo({ ...args, signal: controller.signal }), /paused/);
  assert.equal(task.assetVideoJobs.call1.id, 'video-1');
  assert.equal(task.assetVideoJobs.call1.prompt, input.prompt);
  ark.getVideo = async () => ({ status: 'failed', error: { code: 'OutputRejected', message: 'platform review failed' } });
  await assert.rejects(generateAssetVideo({ ...args, signal: new AbortController().signal }), /platform review failed/);
  assert.equal(requests.length, 1);
  assert.equal(task.assetVideoJobs.call1.file, undefined);
});
