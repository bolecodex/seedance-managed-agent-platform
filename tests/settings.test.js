import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSettings } from '../lib/settings.js';
import { listen, mockArk, startServer, until } from './helpers/server.js';

async function store(t, env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'visionary-settings-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, settings: createSettings({ dataDir, env }) };
}
const change = (settings, values, extra = {}) => settings.prepare({ revision: settings.publicSettings().revision, values, ...extra });
const save = async (request, values, extra = {}) => request('/api/settings', { revision: (await request('/api/settings')).revision, values, ...extra });

test('settings keep credentials private, support explicit clearing and inheritance, and persist atomically', async t => {
  const env = { ARK_API_KEY: 'inherited-sensitive-key', ARK_SECRET_KEY: 'inherited-secret', ARK_PROJECT_NAME: 'original' };
  const { settings, dataDir } = await store(t, env);
  const initial = settings.publicSettings();
  assert.equal(initial.fields.find(field => field.key === 'ARK_API_KEY').configured, true);
  assert.equal(initial.fields.find(field => field.key === 'ARK_API_KEY').source, 'environment');
  assert.ok(!JSON.stringify(initial).includes('inherited-sensitive-key'));
  settings.commit(change(settings, { ARK_API_KEY: 'new-sensitive-key', ARK_PROJECT_NAME: 'new-project' }));
  assert.equal(settings.effective().ARK_SECRET_KEY, 'inherited-secret');
  const restored = createSettings({ dataDir, env });
  assert.equal(restored.effective().ARK_API_KEY, 'new-sensitive-key');
  assert.equal(restored.effective().ARK_PROJECT_NAME, 'new-project');
  assert.equal((await stat(path.join(dataDir, 'settings.json'))).mode & 0o777, 0o600);
  assert.throws(() => settings.prepare({ revision: initial.revision, values: {} }), /其他页面更新/);
  settings.commit(change(settings, { ARK_API_KEY: '' }));
  assert.equal(settings.effective().ARK_API_KEY, '');
  assert.equal(settings.publicSettings().fields.find(field => field.key === 'ARK_API_KEY').configured, false);
  settings.commit(change(settings, { ARK_API_KEY: null }));
  assert.equal(settings.effective().ARK_API_KEY, env.ARK_API_KEY);
  settings.commit(change(settings, {}, { reset: true }));
  assert.equal(settings.effective().ARK_PROJECT_NAME, 'original');
  assert.equal(settings.redact('new-sensitive-key inherited-sensitive-key inherited-secret'), '[已隐藏] [已隐藏] [已隐藏]');
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).values, {});
  assert.equal(env.ARK_API_KEY, 'inherited-sensitive-key');
});

test('settings validate an entire update before writing or changing state', async t => {
  const { settings, dataDir } = await store(t);
  for (const values of [
    { UNKNOWN_API_KEY: 'not-supported' }, { HOST: '0.0.0.0' }, { PORT: 1234 },
    { ARK_API_KEY: 123 }, { ARK_API_KEY: 'secret\nline' },
    { ARK_BASE_URL: 'file:///tmp/key' }, { ARK_BASE_URL: 'https://name:password@example.test' },
    { ARK_BASE_URL: 'https://example.test?key=secret' }, { ARK_BASE_URL: 'https://example.test/#fragment' },
    { ARK_ASSET_API_URL: 'https://example.test/path' },
    { ARK_REAL_PERSON_CALLBACK_URL: 'http://example.test' }, { ARK_REAL_PERSON_CALLBACK_URL: 'https://localhost/callback' },
    { MAX_CONCURRENT_TASKS: 0 }, { MAX_CONCURRENT_TASKS: 33 }, { MAX_CONCURRENT_TASKS: 1.5 }, { MAX_CONCURRENT_TASKS: 'hello' },
    { ARK_API_KEY: 'would-be-secret', ARK_BASE_URL: 'bad-url' }
  ]) assert.throws(() => settings.commit(change(settings, values)), { status: 400 });
  assert.equal(settings.effective().ARK_API_KEY, '');
  await assert.rejects(stat(path.join(dataDir, 'settings.json')), { code: 'ENOENT' });
  const valid = change(settings, { ARK_BASE_URL: ' http://127.0.0.1:7000/api/v3/// ', MAX_CONCURRENT_TASKS: 5 });
  settings.commit(valid);
  assert.equal(settings.effective().ARK_BASE_URL, 'http://127.0.0.1:7000/api/v3');
  assert.equal(settings.effective().MAX_CONCURRENT_TASKS, '5');
});

test('damaged persisted settings are not overwritten', async t => {
  const { dataDir } = await store(t);
  const filename = path.join(dataDir, 'settings.json');
  await writeFile(filename, '{broken');
  assert.throws(() => createSettings({ dataDir, env: {} }), /不会覆盖/);
  assert.equal(await readFile(filename, 'utf8'), '{broken');
});

test('saving config hot-swaps Agent requests and survives restart without exposing keys', async t => {
  const ark = await mockArk(t);
  const first = await startServer(t);
  assert.equal((await first.request('/api/config')).configured, false);
  const result = await save(first.request, { ARK_API_KEY: 'saved-local-key', ARK_BASE_URL: ark.baseUrl, ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_IMAGE_MODEL: 'new-image-model' });
  assert.equal(result.status, 200);
  assert.equal(result.config.configured, true);
  assert.ok(!JSON.stringify(result).includes('saved-local-key'));
  const check = await first.request('/api/settings/test', { revision: result.settings.revision });
  assert.equal(check.ok, true);
  assert.equal(ark.sessions.size, 0, 'connection tests must not create sessions');
  const created = await first.request('/api/creative', { prompt: 'hot configuration' });
  assert.equal(created.task.demo, false);
  await until(() => [...ark.sessions.values()].some(session => session.submissions === 1));
  ark.finish([...ark.sessions.values()][0]);
  await until(async () => (await first.request(`/api/tasks/${created.task.id}`)).task.status === 'completed');
  const exited = once(first.child, 'exit'); first.child.kill('SIGTERM'); await exited;
  const second = await startServer(t, { VISIONARY_DATA_DIR: first.dataDir });
  assert.equal((await second.request('/api/config')).configured, true);
  assert.equal((await second.request('/api/settings')).fields.find(field => field.key === 'ARK_IMAGE_MODEL').value, 'new-image-model');
  const cleared = await save(second.request, { ARK_API_KEY: '' });
  assert.equal(cleared.config.filesApiConfigured, false);
  const blocked = await second.request(`/api/tasks/${created.task.id}/messages`, { prompt: 'do not send without key' });
  assert.equal(blocked.status, 409);
});

test('active and queued work prevents credential changes, but concurrency remains adjustable', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, { ARK_API_KEY: 'original-local-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl, MAX_CONCURRENT_TASKS: '1' });
  const first = await request('/api/creative', { prompt: 'first' });
  await request('/api/creative', { prompt: 'second' });
  await until(() => ark.sessions.size === 1 && [...ark.sessions.values()][0].submissions === 1);
  const before = await request('/api/settings');
  const denied = await request('/api/settings', { revision: before.revision, values: { ARK_API_KEY: 'blocked-new-key' } });
  assert.equal(denied.status, 409);
  assert.equal((await request('/api/settings')).revision, before.revision);
  const increased = await save(request, { MAX_CONCURRENT_TASKS: 2 });
  assert.equal(increased.status, 200);
  await until(() => ark.sessions.size === 2 && [...ark.sessions.values()].every(session => session.submissions === 1));
  for (const session of ark.sessions.values()) ark.finish(session);
  await until(async () => (await request('/api/tasks')).items.every(task => task.status === 'completed'));
  assert.equal((await save(request, { ARK_PROJECT_NAME: 'different-project' })).status, 200);
  assert.equal((await request(`/api/tasks/${first.task.id}/messages`, { prompt: 'old connection' })).status, 409);
  assert.equal((await request(`/api/tasks/${first.task.id}/refresh-outputs`, {})).status, 409);
});

test('connection tests use newly saved API and signing keys and redact upstream errors', async t => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ authorization: request.headers.authorization, token: request.headers['x-security-token'], url: request.url });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [], Result: { Items: [] } }));
  });
  const baseUrl = await listen(upstream);
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const { request } = await startServer(t);
  const saved = await save(request, { ARK_API_KEY: 'new-api-sensitive', ARK_ACCESS_KEY: 'new-access-sensitive', ARK_SECRET_KEY: 'new-secret-sensitive', ARK_SESSION_TOKEN: 'new-session-sensitive', ARK_BASE_URL: baseUrl, ARK_ASSET_API_URL: baseUrl });
  assert.equal(saved.status, 200);
  const checked = await request('/api/settings/test', { revision: saved.settings.revision });
  assert.equal(checked.ok, true);
  assert.equal(received[0].authorization, 'Bearer new-api-sensitive');
  assert.match(received[1].authorization, /Credential=new-access-sensitive\//);
  assert.equal(received[1].token, 'new-session-sensitive');
  upstream.removeAllListeners('request');
  upstream.on('request', (req, res) => { req.resume(); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'new-api-sensitive new-access-sensitive new-secret-sensitive new-session-sensitive' } })); });
  const failed = await request('/api/settings/test', { revision: saved.settings.revision });
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes('sensitive'));
  assert.match(failed.checks[0].message, /已隐藏/);
});

test('settings endpoint rejects stale updates, unknown keys and cross-site writes', async t => {
  const { request, baseUrl } = await startServer(t);
  const initial = await request('/api/settings');
  assert.equal((await save(request, { ARK_AGENT_ID: 'some-agent' })).status, 200);
  assert.equal((await request('/api/settings', { revision: initial.revision, values: { ARK_AGENT_ID: 'stale-agent' } })).status, 409);
  assert.equal((await save(request, { PORT: 4000 })).status, 400);
  const response = await fetch(`${baseUrl}/api/settings`, { method: 'POST', headers: { Origin: 'https://elsewhere.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: initial.revision, values: {} }) });
  assert.equal(response.status, 403);
});

test('changing AK/SK removes and restores portrait tools on the original session', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl, ARK_ACCESS_KEY: 'local-test-ak', ARK_SECRET_KEY: 'local-test-sk' });
  const { task } = await request('/api/creative', { prompt: 'initial with portrait tools' });
  await until(() => [...ark.sessions.values()].some(session => session.submissions === 1));
  const session = [...ark.sessions.values()][0];
  assert.ok(session.agent.tools.some(tool => tool.name === 'prepare_portrait_assets'));
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  await save(request, { ARK_ACCESS_KEY: '', ARK_SECRET_KEY: '' });
  await request(`/api/tasks/${task.id}/messages`, { prompt: 'continue without portrait credentials' });
  await until(() => session.submissions === 2);
  const disabled = session.upgrades.at(-1).agent.tools;
  assert.ok(!disabled.some(tool => ['prepare_portrait_assets', 'generate_video_with_assets'].includes(tool.name)));
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
  await save(request, { ARK_ACCESS_KEY: null, ARK_SECRET_KEY: null });
  await request(`/api/tasks/${task.id}/messages`, { prompt: 'continue with portrait credentials restored' });
  await until(() => session.submissions === 3);
  assert.ok(session.upgrades.at(-1).agent.tools.some(tool => tool.name === 'prepare_portrait_assets'));
  assert.equal(ark.sessions.size, 1);
  ark.finish(session);
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.status === 'completed');
});
