import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const configured = ark => ({ ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });

async function openPage(t, baseUrl) {
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('https://files.test/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.goto(baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  return page;
}

test('a new message renders before its POST completes and replaces the optimistic entry once', async t => {
  const ark = await mockArk(t);
  const { baseUrl, request } = await startServer(t, configured(ark));
  const page = await openPage(t, baseUrl);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let submitting = false;
  await page.route('**/api/creative', async route => {
    submitting = true;
    await held;
    await route.continue();
  });
  const prompt = '发送后立即展示这条需求，保留换行\n<script>window.messageXss = true</script>';
  await page.locator('#prompt').fill(prompt);
  await page.locator('#runBtn').click();
  await until(() => submitting);
  assert.equal((await request('/api/tasks')).items.length, 0);
  assert.equal(await page.locator('.chat-user .chat-message-content').textContent(), prompt);
  assert.match(await page.locator('.chat-user .chat-message-heading').textContent(), /发送中/);
  assert.equal(await page.locator('.chat-user').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('#studioScroll').getBoundingClientRect().bottom), true);
  assert.equal(await page.evaluate(() => window.messageXss), undefined);
  const requestId = await page.locator('.chat-user').getAttribute('data-request-id');
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  release();
  const { task } = await (await accepted).json();
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  await until(() => page.locator('.chat-user').getAttribute('data-message-id').then(id => id === task.messages[0].id));
  assert.equal(await page.locator('.chat-user').count(), 1);
  assert.equal(await page.locator('.chat-user').getAttribute('data-request-id'), requestId);
  assert.equal(await page.locator('#prompt').inputValue(), '');
  await page.reload();
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  assert.equal(await page.locator('.chat-user .chat-message-content').textContent(), prompt);
  assert.equal([...ark.sessions.values()][0].submissions, 1);
});

test('queued follow-ups remain in the timeline during slow requests, streaming, reload and delivery', async t => {
  const ark = await mockArk(t);
  const { baseUrl, request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: '制作一支产品宣传片' });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  const page = await openPage(t, baseUrl);
  await page.locator(`#recentTasks [data-task="${task.id}"]`).click();
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  ark.emit(session, { type: 'agent.message', content: [{ type: 'text', text: '已有执行记录与回复。\n'.repeat(100) }] });
  await until(() => page.locator('.chat-assistant').count());
  await page.evaluate(() => { document.querySelector('#studioScroll').scrollTop = 0; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let submitting = false;
  await page.route(`**/api/tasks/${task.id}/messages`, async route => {
    if (route.request().method() === 'POST') {
      submitting = true;
      await held;
    }
    await route.continue();
  });
  const prompt = '刚刚补充的要求必须立即出现在这里，并使用暖色灯光。';
  await page.locator('#prompt').fill(prompt);
  await page.locator('#prompt').press('Enter');
  await until(() => submitting);
  const message = page.locator('.chat-user').last();
  assert.equal(await message.locator('.chat-message-content').textContent(), prompt);
  assert.match(await message.locator('.chat-message-heading').textContent(), /发送中/);
  await until(() => message.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const viewport = document.querySelector('#studioScroll').getBoundingClientRect();
    return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
  }));
  assert.equal(session.submissions, 1);
  ark.emit(session, { type: 'agent.thinking', content: [{ type: 'text', text: '处理当前轮次时仍然能看到刚才发送的补充需求。' }] });
  await until(() => page.locator('.execution-step-body').textContent().then(text => text.includes('处理当前轮次')));
  assert.equal(await message.locator('.chat-message-content').textContent(), prompt);
  release();
  await until(() => page.locator('#pendingMessages').textContent().then(text => text.includes(prompt)));
  assert.equal(await page.locator('.chat-user').count(), 2);
  assert.match(await message.locator('.chat-message-heading').textContent(), /已排队/);
  const queued = (await request(`/api/tasks/${task.id}`)).task.pendingMessages[0];
  assert.ok(queued.timelineOrder > task.messages[0].timelineOrder);
  ark.emit(session, { type: 'agent.message', content: [{ type: 'text', text: '当前轮次的新回复。' }] });
  await until(() => page.locator('.chat-assistant').last().textContent().then(text => text.includes('当前轮次的新回复')));
  assert.equal(await page.locator('#messageTimeline').evaluate(element => {
    const children = [...element.children];
    return children.findIndex(node => node.textContent.includes('刚刚补充的要求')) < children.findIndex(node => node.textContent.includes('当前轮次的新回复'));
  }), true);
  await page.reload();
  await until(() => page.locator('.chat-user').count().then(count => count === 2));
  assert.equal(await page.locator('.chat-user').last().locator('.chat-message-content').textContent(), prompt);
  assert.match(await page.locator('.chat-user').last().locator('.chat-message-heading').textContent(), /已排队/);
  const screenshot = process.env.VISIONARY_SCREENSHOT;
  if (screenshot) {
    await mkdir(path.dirname(screenshot), { recursive: true });
    await page.evaluate(() => { document.querySelector('#studioScroll').scrollTop = document.querySelector('#studioScroll').scrollHeight; });
    await page.screenshot({ path: `${screenshot}-message-visible-desktop.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${screenshot}-message-visible-mobile.png`, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  ark.finish(session, false, { text: '第一轮完成。' });
  await until(() => session.submissions === 2);
  ark.finish(session, false, { text: '暖色灯光的补充需求已完成。' });
  await until(() => page.locator('#pendingMessages').isHidden());
  await until(() => page.locator('#statusText').textContent().then(text => text === '创作已完成'));
  assert.equal(await page.locator('.chat-user').count(), 2);
  assert.doesNotMatch(await page.locator('.chat-user').last().locator('.chat-message-heading').textContent(), /已排队|发送中/);
  assert.equal((await request(`/api/tasks/${task.id}`)).task.messages.find(item => item.id === queued.id).timelineOrder, queued.timelineOrder);
});

test('a failed follow-up stays visible, retries without duplication, and can be removed from the queue', async t => {
  const ark = await mockArk(t);
  const { baseUrl, request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: '等待补充需求' });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const page = await openPage(t, baseUrl);
  await page.locator(`#recentTasks [data-task="${task.id}"]`).click();
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  let requestId;
  await page.route(`**/api/tasks/${task.id}/messages`, async route => {
    const body = route.request().postDataJSON();
    if (!requestId) { requestId = body.requestId; await route.abort('connectionfailed'); }
    else { assert.equal(body.requestId, requestId); await route.continue(); }
  });
  const prompt = '网络失败也要保留我刚才发送的消息';
  await page.locator('#prompt').fill(prompt);
  await page.locator('#runBtn').click();
  await until(() => page.locator('.chat-user').last().locator('.chat-message-heading').textContent().then(text => text.includes('发送失败')));
  assert.equal(await page.locator('.chat-user').last().locator('.chat-message-content').textContent(), prompt);
  assert.equal(await page.locator('#prompt').inputValue(), prompt);
  await page.locator('#runBtn').click();
  await until(() => page.locator('#pendingMessages').textContent().then(text => text.includes(prompt)));
  assert.equal(await page.locator('.chat-user').count(), 2);
  assert.equal((await request(`/api/tasks/${task.id}`)).task.messages.filter(item => item.text === prompt).length, 1);
  await page.locator('[data-remove-message]').click();
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  assert.equal(await page.locator('#pendingMessages').isHidden(), true);
});
