import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, mockArk, until } from './helpers/server.js';

test('accepts six jobs immediately, runs two concurrently and completes after clients disconnect', async t => {
  const { request, dataDir } = await startServer(t);
  const submitted = await Promise.all(Array.from({ length: 6 }, (_, index) => request('/api/creative', { prompt: `Background demo ${index}`, options: { aspectRatio: index % 2 ? '16:9' : '1:1' } })));
  assert.ok(submitted.every(result => result.status === 202));
  assert.equal(new Set(submitted.map(result => result.task.id)).size, 6);
  const active = await request('/api/tasks');
  assert.equal(active.items.filter(task => task.status === 'running').length, 2);
  assert.equal(active.items.filter(task => task.status === 'queued').length, 4);
  await until(async () => (await request('/api/tasks')).items.every(task => task.status === 'completed'));
  for (const { task: summary } of submitted) {
    const { task } = await request(`/api/tasks/${summary.id}`);
    assert.ok(task.result.includes(task.prompt));
    assert.equal(task.options.aspectRatio, summary.options.aspectRatio);
    assert.equal(task.events.filter(event => event.type === 'demo.start').length, 1);
  }
  const stored = JSON.parse(await readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.equal(stored.length, 6);
  assert.ok(stored.every(task => task.status === 'completed'));
});

test('isolates live sessions and results, queues extra jobs and frees failed slots without resubmission', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const submitted = [];
  for (let index = 0; index < 5; index++) submitted.push(await request('/api/creative', { prompt: `Live task ${index}` }));
  assert.ok(submitted.every(result => result.status === 202));
  await until(() => ark.sessions.size === 2 && [...ark.sessions.values()].every(session => session.submissions === 1));
  const initial = await request('/api/tasks');
  assert.equal(initial.items.filter(task => task.status === 'running').length, 2);
  assert.equal(initial.items.filter(task => task.status === 'queued').length, 3);
  const first = [...ark.sessions.values()][0];
  ark.finish(first, true);
  await until(() => ark.sessions.size === 3 && [...ark.sessions.values()].at(-1).submissions === 1);
  const failed = await request(`/api/tasks/${submitted[0].task.id}`);
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.task.error, 'test generation failed');
  ark.finish([...ark.sessions.values()][1]);
  ark.finish([...ark.sessions.values()][2]);
  await until(() => ark.sessions.size === 5 && [...ark.sessions.values()].slice(3).every(session => session.submissions === 1));
  ark.finish([...ark.sessions.values()][3]);
  ark.finish([...ark.sessions.values()][4]);
  await until(async () => (await request('/api/tasks')).items.every(task => ['completed', 'failed'].includes(task.status)));
  for (const { task: summary } of submitted.slice(1)) {
    const { task } = await request(`/api/tasks/${summary.id}`);
    const session = ark.sessions.get(task.sessionId);
    assert.equal(task.status, 'completed');
    assert.equal(session.title, summary.prompt);
    assert.equal(task.result, `Result for ${summary.prompt}`);
    assert.equal(task.files[0].id, `file-${session.id}`);
    assert.equal(task.files[0].download_url, `https://files.test/${session.id}.mp4`);
  }
  assert.ok([...ark.sessions.values()].every(session => session.submissions === 1));
});
