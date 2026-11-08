import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const configured = ark => ({ ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
const settled = (request, id, status = 'completed') => until(async () => { const { task } = await request(`/api/tasks/${id}`); return task.status === status && !task.recoveryPending && task; });

async function openPage(t, baseUrl, taskId) {
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://files.test/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(id => localStorage.setItem('visionary-active-task', id), taskId);
  await page.goto(baseUrl);
  await until(() => page.locator('#conversation').isVisible());
  return { page, errors };
}

async function interruptedConversation(t, { unsent = false } = {}) {
  const ark = await mockArk(t, { historyDelay: 450 });
  const first = await startServer(t, configured(ark));
  const { task } = await first.request('/api/creative', { prompt: 'Create the original product video' });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  ark.finish(session);
  await settled(first.request, task.id);
  const exited = once(first.child, 'exit');
  first.child.kill('SIGTERM');
  await exited;
  const saved = JSON.parse(await readFile(`${first.dataDir}/tasks.json`, 'utf8'));
  Object.assign(saved[0], { status: 'interrupted', connection: 'disconnected', error: 'test connection timeout' });
  if (unsent) saved[0].messages.push({ id: 'sevt-unsent-followup', role: 'user', text: 'Extend the saved video to one minute', delivery: 'queued', assetIds: [], createdAt: new Date().toISOString() });
  await writeFile(`${first.dataDir}/tasks.json`, JSON.stringify(saved));
  const server = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  return { ...server, ark, session, task };
}

test('sending restores a disconnected Session and submits only the new follow-up once', async t => {
  const { baseUrl, request, ark, session, task } = await interruptedConversation(t);
  const { page, errors } = await openPage(t, baseUrl, task.id);
  await until(() => page.locator('#runBtn').getAttribute('aria-label').then(text => text === '恢复会话并发送'));
  const prompt = '视频太短了，做成1分钟的';
  let recoveries = 0;
  const submissions = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/recover')) recoveries++;
    if (request.url().endsWith('/messages')) submissions.push(request.postDataJSON());
  });
  await page.locator('#prompt').fill(prompt);
  await page.locator('#runBtn').click();
  await until(() => recoveries === 1);
  assert.equal(await page.locator('#prompt').inputValue(), prompt);
  assert.equal(await page.locator('#runBtn').isDisabled(), true);
  await page.locator('#prompt').press('Enter');
  await until(() => session.submissions === 2);
  await until(() => page.locator('#prompt').inputValue().then(text => text === ''));
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].prompt, prompt);
  assert.equal(recoveries, 1);
  assert.equal(ark.sessions.size, 1);
  ark.finish(session);
  await settled(request, task.id);

  // A connected interruption can accept a new user instruction directly.
  await page.locator('#prompt').fill('Keep the original product appearance');
  await page.locator('#prompt').press('Enter');
  await until(() => session.submissions === 3);
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle' });
  await settled(request, task.id, 'interrupted');
  await until(() => page.locator('#runBtn').isEnabled());
  await page.locator('#prompt').fill('Finish this version');
  await page.locator('#prompt').press('Enter');
  await until(() => session.submissions === 4);
  assert.equal(recoveries, 1);
  ark.finish(session);
  await settled(request, task.id);
  assert.deepEqual(errors, []);
  if (process.env.VISIONARY_SCREENSHOT) {
    await mkdir(path.dirname(process.env.VISIONARY_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: `${process.env.VISIONARY_SCREENSHOT}-message-recovery.png`, animations: 'disabled' });
  }
});

test('recovery that discovers a tool approval preserves the draft and reveals explicit controls', async t => {
  const { baseUrl, request, ark, session, task } = await interruptedConversation(t);
  const tool = ark.emit(session, { type: 'agent.tool_use', name: 'video_generate', input: { prompt: 'One minute film' } });
  ark.finish(session, false, { stopReason: 'requires_action', eventIds: [tool.id] });
  const { page, errors } = await openPage(t, baseUrl, task.id);
  await until(() => page.locator('#runBtn').isEnabled());
  await page.locator('#prompt').fill('Keep this draft until I approve');
  await page.locator('#prompt').press('Enter');
  await until(() => page.locator('#approvalPanel').isVisible());
  assert.equal((await settled(request, task.id, 'waiting')).pendingApprovals[0], tool.id);
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft until I approve');
  assert.equal(await page.locator('#runBtn').isDisabled(), true);
  assert.equal(session.submissions, 1);
  assert.equal(session.confirmations.length, 0);
  await until(() => page.locator('#toast').textContent().then(text => text.includes('待确认的工具调用')));
  assert.deepEqual(errors, []);
});

test('failed recovery preserves the draft and its request ID for a successful retry', async t => {
  const { baseUrl, request, ark, session, task } = await interruptedConversation(t);
  const { page, errors } = await openPage(t, baseUrl, task.id);
  let failRecovery = true;
  await page.route(`**/api/tasks/${task.id}/recover`, route => failRecovery ? route.fulfill({ status: 503, json: { error: 'test recovery unavailable' } }) : route.continue());
  await until(() => page.locator('#runBtn').isEnabled());
  const prompt = 'Preserve this one minute video request';
  await page.locator('#prompt').fill(prompt);
  await page.locator('#runBtn').click();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('test recovery unavailable')));
  assert.equal(await page.locator('#prompt').inputValue(), prompt);
  assert.equal(session.submissions, 1);
  const saved = await page.evaluate(id => JSON.parse(localStorage.getItem(`visionary-draft:${id}`)), task.id);
  failRecovery = false;
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/messages'));
  await page.locator('#runBtn').click();
  assert.equal((await posted).postDataJSON().requestId, saved.submission.requestId);
  await until(() => session.submissions === 2);
  ark.finish(session);
  await settled(request, task.id);
  assert.equal(ark.sessions.size, 1);
  assert.deepEqual(errors, []);
});

test('switching conversations during recovery keeps the draft without sending it in the background', async t => {
  const { baseUrl, request, session, task } = await interruptedConversation(t);
  const { page, errors } = await openPage(t, baseUrl, task.id);
  await until(() => page.locator('#runBtn').isEnabled());
  await page.locator('#prompt').fill('Keep this draft in its own conversation');
  const recovering = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/recover'));
  await page.locator('#runBtn').click();
  await recovering;
  await page.locator('#headerNewTask').click();
  await page.locator('#prompt').fill('Independent new conversation draft');
  await settled(request, task.id);
  assert.equal(session.submissions, 1);
  assert.equal(await page.locator('#prompt').inputValue(), 'Independent new conversation draft');
  await page.locator(`#recentTasks [data-task="${task.id}"]`).click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft in its own conversation');
  assert.deepEqual(errors, []);
});

test('an unsent saved message has a visible continuation action beside the composer', async t => {
  const { baseUrl, request, ark, session, task } = await interruptedConversation(t, { unsent: true });
  await request(`/api/tasks/${task.id}/recover`, {});
  await settled(request, task.id, 'interrupted');
  const { page, errors } = await openPage(t, baseUrl, task.id);
  const action = page.locator('#composerRecovery button');
  await until(() => action.isVisible());
  assert.match(await action.textContent(), /继续执行已保存消息/);
  assert.equal(await page.locator('#runBtn').isDisabled(), true);
  await page.locator('#prompt').fill('Preserve my separate draft');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = await action.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 1000);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await action.click();
  await until(() => session.submissions === 2);
  assert.match(session.messages[1].content[0].text, /^Extend the saved video to one minute/);
  assert.equal(await page.locator('#prompt').inputValue(), 'Preserve my separate draft');
  ark.finish(session);
  await settled(request, task.id);
  assert.deepEqual(errors, []);
});
