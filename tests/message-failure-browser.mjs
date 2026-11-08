import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const configured = ark => ({ ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });

test('unsent messages remain visible after failure, reload, asset sync failure and retry', async t => {
  const ark = await mockArk(t, { sessionFailures: 1, readyChunks: [': ready\n'] });
  const { baseUrl, request } = await startServer(t, configured(ark));
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // A remote asset-library outage must not break chat startup or restoration.
  await page.route('**/api/config', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), avatarLibraryConfigured: true } });
  });
  await page.route('**/api/avatar-groups*', route => route.fulfill({ status: 503, json: { error: 'test asset service unavailable' } }));
  await page.route('https://files.test/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.goto(baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  const prompt = 'hi — keep my original message';
  await page.locator('#prompt').fill(prompt);
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  await page.locator('#prompt').press('Enter');
  const { task } = await (await accepted).json();
  await until(() => page.locator('#recoveryPanel').textContent().then(text => text.includes('test session creation failed')));
  assert.equal(await page.locator('.chat-user .chat-message-content').textContent(), prompt);
  assert.match(await page.locator('.chat-user .chat-message-heading').textContent(), /已保存/);
  assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(ark.sessions.size, 0);

  await page.reload();
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  assert.equal(await page.locator('.chat-user .chat-message-content').textContent(), prompt);
  assert.match(await page.locator('#connectionText').textContent(), /配置就绪/);
  assert.equal((await request(`/api/tasks/${task.id}`)).task.messages[0].text, prompt);

  await page.locator('#resumeTask').click();
  await until(() => [...ark.sessions.values()][0]?.submissions === 1, 2000);
  const session = [...ark.sessions.values()][0];
  ark.finish(session);
  await until(() => page.locator('#statusText').textContent().then(text => text === '创作已完成'));
  assert.equal(await page.locator('.chat-user').count(), 1);
  assert.equal(session.submissions, 1);
  assert.deepEqual(errors, []);
});

test('a failed local POST preserves the draft and retries with the same request ID', async t => {
  const { baseUrl, request } = await startServer(t);
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let requestId;
  let failed = false;
  await page.route('**/api/creative', async route => {
    const body = route.request().postDataJSON();
    if (!failed) { failed = true; requestId = body.requestId; await route.abort('connectionfailed'); }
    else { assert.equal(body.requestId, requestId); await route.continue(); }
  });
  await page.goto(baseUrl);
  await page.locator('#prompt').fill('Keep this draft after a network error');
  await page.locator('#runBtn').click();
  await until(() => page.locator('#progressDetail').textContent().then(text => text.includes('草稿已保留')));
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft after a network error');
  assert.equal(await page.locator('.chat-user .chat-message-content').textContent(), 'Keep this draft after a network error');
  assert.match(await page.locator('.chat-user .chat-message-heading').textContent(), /发送失败 · 草稿已保留/);
  await page.reload();
  await until(() => page.locator('#prompt').inputValue().then(text => text === 'Keep this draft after a network error'));
  await page.locator('#runBtn').click();
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  assert.equal((await request('/api/tasks')).items.length, 1);
});
