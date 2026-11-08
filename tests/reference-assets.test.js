import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { mockArk, startServer, until } from './helpers/server.js';
import { createReferenceAssetTool } from '../lib/reference-assets.js';

async function setup(t, options) {
  const ark = await mockArk(t, options);
  const server = await startServer(t, {
    ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment',
    ARK_BASE_URL: ark.baseUrl, ARK_ASSET_API_URL: ark.baseUrl, ARK_ACCESS_KEY: 'asset-test-ak', ARK_SECRET_KEY: 'asset-test-sk', ARK_VIDEO_MODEL: 'test-seedance'
  });
  const upload = async name => {
    const response = await fetch(`${server.baseUrl}/api/uploads`, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name), 'X-Collection': 'reference' }, body: 'test image' });
    assert.equal(response.status, 201);
    return (await response.json()).item;
  };
  return { ark, ...server, upload, env: { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl, ARK_ASSET_API_URL: ark.baseUrl, ARK_ACCESS_KEY: 'asset-test-ak', ARK_SECRET_KEY: 'asset-test-sk', ARK_VIDEO_MODEL: 'test-seedance' } };
}

function enroll(ark, session, ids, portraitType = 'virtual') {
  const call = ark.emit(session, { type: 'agent.custom_tool_use', name: 'prepare_portrait_assets', input: { asset_ids: ids, portrait_type: portraitType } });
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [call.id] } });
  return call;
}

test('enrolls portrait references before resuming the same session, preserving mixed reference order and reusing uploads', async t => {
  const { ark, upload, request, dataDir } = await setup(t);
  const room = await upload('classroom.png');
  const person = await upload('character.png');
  const { task } = await request('/api/creative', { prompt: '图片1教室，图片2虚构角色，生成30秒动作视频。', assetIds: [room.id, person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  assert.ok(session.agent.tools.some(tool => tool.type === 'custom' && tool.name === 'prepare_portrait_assets'));
  assert.ok(session.agent.tools.find(tool => tool.type === 'agent_toolset_multimodal_20260825').configs.some(config => config.name === 'todo_write' && config.enabled));
  assert.match(session.message.events[1].content[0].text, /必须先调用 prepare_portrait_assets/);
  assert.match(session.messages[0].content[0].text, new RegExp(`图片 1：classroom.png；本机素材 ID=${room.id}[\\s\\S]*图片 2：character.png；本机素材 ID=${person.id}`));
  enroll(ark, session, [person.id]);
  await until(() => session.customResults.length === 1);
  const result = JSON.parse(session.customResults[0].content[0].text);
  assert.equal(result.status, 'Active');
  assert.equal(result.references[0].uri, 'asset://asset-test-1');
  assert.equal(session.submissions, 1);
  assert.equal(session.sentBeforeReady, undefined);
  assert.equal(ark.assets.size, 1);
  assert.equal(ark.assetRequests.find(item => item.action === 'CreateAsset').body.URL, `https://files.test/${person.arkFileId}`);
  const stored = JSON.parse(await readFile(path.join(dataDir, 'assets.json'), 'utf8'));
  assert.equal(stored.find(item => item.id === person.id).remoteStatus, 'Active');
  assert.equal(stored.find(item => item.id === room.id).assetId, undefined);
  const video = ark.emit(session, { type: 'agent.custom_tool_use', name: 'generate_video_with_assets', input: { prompt: '图片1教室，图片2角色，30秒完整动作时间轴。', asset_ids: [room.id, person.id], duration: 30, ratio: '9:16', resolution: '720p', generate_audio: true, output_path: '/mnt/session/outputs/portrait.mp4' } });
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [video.id] } });
  await until(() => session.customResults.length === 2);
  assert.equal(session.customResults[1].is_error, false);
  assert.equal(ark.videoRequests.length, 1);
  assert.equal(ark.videoRequests[0].content[1].image_url.url, `https://files.test/${room.arkFileId}`);
  assert.equal(ark.videoRequests[0].content[2].image_url.url, 'asset://asset-test-1');
  assert.equal(ark.videoRequests[0].duration, 30);
  assert.equal(ark.videoRequests[0].watermark, false);
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  const done = (await request(`/api/tasks/${task.id}`)).task;
  assert.equal(done.executionSteps.find(step => step.name === 'prepare_portrait_assets').status, 'completed');
  assert.equal(Object.values(done.referenceAssetResults)[0].status, 'sent');
  assert.equal(done.files[0].download_url, 'https://files.test/generated.mp4');
});

test('waits for Active and reuses an in-progress asset after local pause and resume', async t => {
  const { ark, upload, request } = await setup(t, { assetStatus: 'Processing' });
  const person = await upload('character.png');
  const { task } = await request('/api/creative', { prompt: '虚构人物生成视频', assetIds: [person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  enroll(ark, session, [person.id]);
  await until(() => ark.assetRequests.some(item => item.action === 'GetAsset'));
  assert.equal(session.customResults.length, 0);
  assert.equal((await request(`/api/tasks/${task.id}/pause`, {})).task.status, 'paused');
  [...ark.assets.values()][0].Status = 'Active';
  const resumed = await request(`/api/tasks/${task.id}/resume`, {});
  assert.equal(resumed.status, 202);
  await until(() => session.customResults.length === 1);
  assert.equal(ark.assets.size, 1);
  assert.equal(session.submissions, 1);
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
});

test('returns platform review failures and refuses undeclared assets or invalid source markers', async t => {
  const { ark, upload, request } = await setup(t, { assetStatus: 'Failed' });
  const person = await upload('character.png');
  const { task } = await request('/api/creative', { prompt: '虚构人物生成视频', assetIds: [person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  enroll(ark, session, [person.id], 'real');
  await until(() => session.customResults.length === 1);
  assert.equal(session.customResults[0].is_error, true);
  assert.match(session.customResults[0].content[0].text, /未通过/);
  ark.finish(session, false, { text: '素材审核失败，未生成视频。' });
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  const tool = createReferenceAssetTool({ avatars: {}, getAssets: () => [{ ...person }], project: 'yingke', redact: value => value });
  const context = { messages: [{ role: 'user', delivery: 'sent', assetIds: [person.id] }] };
  await assert.rejects(tool.execute(context, { asset_ids: ['another-asset'], portrait_type: 'virtual' }), /明确添加/);
  await assert.rejects(tool.execute(context, { asset_ids: [person.id], portrait_type: 'invalid' }), /来源标记/);
});

test('real portraits use AIGC enrollment without H5 verification and retain their real source marker', async t => {
  const { ark, upload, request, dataDir } = await setup(t);
  const person = await upload('real-person.png');
  const { task } = await request('/api/creative', { prompt: '使用这张真人参考图生成视频，先入 AIGC 库。', assetIds: [person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  assert.match(session.message.events[1].content[0].text, /真人.*统一提交当前项目的 GroupType=AIGC/);
  const definition = session.agent.tools.find(tool => tool.name === 'prepare_portrait_assets');
  assert.deepEqual(definition.input_schema.required, ['asset_ids']);
  assert.doesNotMatch(definition.description, /需已有认证/);
  enroll(ark, session, [person.id], 'real');
  await until(() => session.customResults.length === 1);
  assert.equal(session.customResults[0].is_error, false);
  assert.equal(JSON.parse(session.customResults[0].content[0].text).status, 'Active');
  assert.equal(ark.assetRequests.find(item => item.action === 'CreateAssetGroup').body.GroupType, 'AIGC');
  assert.ok(ark.assetRequests.every(item => !/VisualValidate/.test(item.action)));
  const stored = JSON.parse(await readFile(path.join(dataDir, 'assets.json'), 'utf8')).find(item => item.id === person.id);
  assert.equal(stored.portraitType, 'real');
  assert.equal(stored.synthetic, false);
  assert.equal(stored.assetGroupType, 'AIGC');
  assert.equal((await request('/api/assets')).items.find(item => item.id === person.id).portraitType, 'real');
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
});

test('unknown portrait origins can enroll without classification and failed review is not treated as Active', async t => {
  const { ark, upload, request, dataDir } = await setup(t, { assetStatus: 'Failed' });
  const person = await upload('portrait.png');
  const { task } = await request('/api/creative', { prompt: '人像先入库', assetIds: [person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  const call = ark.emit(session, { type: 'agent.custom_tool_use', name: 'prepare_portrait_assets', input: { asset_ids: [person.id] } });
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [call.id] } });
  await until(() => session.customResults.length === 1);
  assert.equal(session.customResults[0].is_error, true);
  assert.match(session.customResults[0].content[0].text, /未通过/);
  assert.doesNotMatch(session.customResults[0].content[0].text, /本人认证|来源标记/);
  const stored = JSON.parse(await readFile(path.join(dataDir, 'assets.json'), 'utf8')).find(item => item.id === person.id);
  assert.equal(stored.synthetic, undefined);
  assert.equal(stored.assetGroupType, 'AIGC');
  assert.equal(stored.remoteStatus, 'Failed');
  assert.equal(ark.videoRequests.length, 0);
  ark.finish(session, false, { text: '平台审核未通过，没有调用视频生成。' });
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
});

test('manual real portrait enrollment defaults to AIGC for reference and legacy private-person files', async t => {
  const { ark, baseUrl, upload, request, dataDir } = await setup(t);
  const reference = await upload('real-reference.png');
  const privateUpload = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', headers: { 'X-File-Name': 'real-private.png', 'X-Collection': 'private-person' }, body: 'real portrait test bytes' });
  const { item: privatePerson } = await privateUpload.json();
  for (const item of [reference, privatePerson]) {
    const rejected = await request(`/api/assets/${item.id}/enroll`, { portraitType: 'real' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.error, /使用权限/);
    const submitted = await request(`/api/assets/${item.id}/enroll`, { consent: true, portraitType: 'real' });
    assert.equal(submitted.status, 202);
    await until(async () => (await request('/api/assets')).items.find(asset => asset.id === item.id)?.remoteStatus === 'Active');
  }
  const stored = JSON.parse(await readFile(path.join(dataDir, 'assets.json'), 'utf8'));
  assert.ok(stored.every(item => item.assetGroupType === 'AIGC' && item.portraitType === 'real' && item.synthetic === false));
  assert.equal(ark.assetRequests.filter(item => item.action === 'CreateAsset').length, 2);
  assert.ok(ark.assetRequests.every(item => !/VisualValidate/.test(item.action)));
});

test('keeps plan mode free of enrollment tools and adds the tool when restoring Agent mode', async t => {
  const { ark, request } = await setup(t);
  const { task } = await request('/api/creative', { prompt: '先规划人物视频', mode: 'plan' });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  assert.ok(session.agent.tools.every(tool => tool.type !== 'custom' && tool.default_config.enabled === false));
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  await request(`/api/tasks/${task.id}/messages`, { prompt: '开始制作', mode: 'agent' });
  await until(() => session.submissions === 2);
  assert.ok(session.upgrades[0].agent.tools.some(tool => tool.name === 'prepare_portrait_assets'));
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
});

test('privacy rejection automatically continues with enrollment instead of ending with replacement suggestions', async t => {
  const { ark, upload, request } = await setup(t);
  const person = await upload('character.png');
  const { task } = await request('/api/creative', { prompt: '虚构人物30秒动作视频', assetIds: [person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  const call = ark.emit(session, { type: 'agent.tool_use', name: 'GenVideo', input: {} });
  ark.emit(session, { type: 'agent.tool_result', tool_use_id: call.id, is_error: true, content: [{ type: 'text', text: 'InputImageSensitiveContentDetected.PrivacyInformation: may contain real person' }] });
  ark.finish(session, false, { text: '生成受阻，请换图。' });
  await until(() => session.submissions === 2);
  assert.match(session.messages[1].content[0].text, /立即按私域人像素材库/);
  assert.match(session.message.events[1].content[0].text, new RegExp(person.id));
  enroll(ark, session, [person.id]);
  await until(() => session.customResults.length === 1);
  ark.finish(session, false, { text: '已使用审核后的素材生成视频。' });
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  assert.equal(session.submissions, 2);
});

test('a lost tool-result POST is recovered without creating a second asset or sending the result twice', async t => {
  const { ark, upload, request } = await setup(t, { customResultFailure: true });
  const person = await upload('character.png');
  const { task } = await request('/api/creative', { prompt: '虚构人物视频', assetIds: [person.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  enroll(ark, session, [person.id]);
  await until(() => session.customResults.length === 1 && session.streams >= 3);
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  assert.equal(session.customResults.length, 1);
  assert.equal(ark.assets.size, 1);
  assert.equal(session.submissions, 1);
});

test('continuing an existing session upgrades its tools without replacing its session or original references', async t => {
  const ark = await mockArk(t);
  const original = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const { task } = await original.request('/api/creative', { prompt: '人物视频' });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  ark.finish(session);
  await until(async () => (await original.request(`/api/tasks/${task.id}`)).task.status === 'completed');
  const exited = once(original.child, 'exit'); original.child.kill('SIGTERM'); await exited;
  const next = await startServer(t, { VISIONARY_DATA_DIR: original.dataDir, ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl, ARK_ASSET_API_URL: ark.baseUrl, ARK_ACCESS_KEY: 'asset-test-ak', ARK_SECRET_KEY: 'asset-test-sk' });
  const submitted = await next.request(`/api/tasks/${task.id}/messages`, { prompt: '先入库再继续' });
  assert.equal(submitted.status, 202);
  await until(() => session.submissions === 2);
  assert.equal(ark.sessions.size, 1);
  assert.ok(session.upgrades[0].agent.tools.some(tool => tool.name === 'prepare_portrait_assets'));
  ark.finish(session);
  await until(async () => (await next.request(`/api/tasks/${task.id}`)).task.status === 'completed');
});

test('server restart resumes an asset awaiting review without submitting another asset or user message', async t => {
  const first = await setup(t, { assetStatus: 'Processing' });
  const person = await first.upload('character.png');
  const { task } = await first.request('/api/creative', { prompt: '人物视频', assetIds: [person.id] });
  await until(() => [...first.ark.sessions.values()][0]?.submissions === 1);
  const session = [...first.ark.sessions.values()][0];
  enroll(first.ark, session, [person.id]);
  await until(() => first.ark.assetRequests.some(item => item.action === 'GetAsset'));
  const exited = once(first.child, 'exit'); first.child.kill('SIGTERM'); await exited;
  [...first.ark.assets.values()][0].Status = 'Active';
  const next = await startServer(t, { ...first.env, VISIONARY_DATA_DIR: first.dataDir });
  await until(() => session.customResults.length === 1);
  assert.equal(first.ark.assets.size, 1);
  assert.equal(session.submissions, 1);
  first.ark.finish(session);
  await until(async () => (await next.request(`/api/tasks/${task.id}`)).task.status === 'completed');
});
