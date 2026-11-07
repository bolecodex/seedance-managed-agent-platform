import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');

test('Codex-style conversation controls, streaming, drafts, goals, recovery, approvals and responsive layout', async t => {
  const ark = await mockArk(t);
  const { baseUrl, request } = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.route('https://files.test/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.goto(baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  await page.locator('#prompt').fill('Create a coffee campaign');
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  await page.locator('#prompt').press('Enter');
  const { task: first } = await (await accepted).json();
  await until(() => [...ark.sessions.values()].some(session => session.submissions === 1));
  const session = [...ark.sessions.values()][0];
  await until(() => page.locator('.chat-user').count().then(count => count === 1));
  assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(await page.locator('#pauseBtn').isVisible(), true);
  ark.emit(session, { type: 'event_start', event: { id: 'sevt-preview-1', type: 'agent.message' } });
  ark.emit(session, { type: 'event_delta', event_id: 'sevt-preview-1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Building **the campaign**…' } } });
  await until(() => page.locator('.streaming').textContent().then(text => text.includes('Building the campaign')));
  await page.locator('#prompt').fill('Use warm light');
  await page.locator('#prompt').press('Shift+Enter');
  await page.locator('#prompt').press('Backspace');
  assert.equal(session.submissions, 1);
  await page.locator('#prompt').press('Enter');
  await until(() => page.locator('#pendingMessages').textContent().then(text => text.includes('Use warm light')));
  assert.equal(session.submissions, 1);
  ark.finish(session, false, { text: 'First complete answer' });
  await until(() => session.submissions === 2);
  ark.finish(session, false, { text: 'Second complete answer' });
  await until(() => page.locator('#messageTimeline').textContent().then(text => text.includes('Second complete answer')));
  await until(() => page.locator('#pauseBtn').isHidden());
  assert.equal(await page.locator('.streaming').count(), 0);
  assert.equal(ark.sessions.size, 1);

  // Each conversation and the new-conversation screen keep an independent draft.
  await page.locator('#prompt').fill('Draft for campaign');
  await page.locator('#headerNewTask').click();
  await page.locator('#prompt').fill('New conversation draft');
  await page.locator(`#recentTasks [data-task="${first.id}"]`).click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Draft for campaign');
  await page.reload();
  await until(() => page.locator('#messageTimeline').textContent().then(text => text.includes('Second complete answer')));
  assert.equal(await page.locator('#prompt').inputValue(), 'Draft for campaign');
  assert.equal(session.submissions, 2);
  await page.locator('#headerNewTask').click();
  assert.equal(await page.locator('#prompt').inputValue(), 'New conversation draft');
  await page.locator(`#recentTasks [data-task="${first.id}"]`).click();

  // Slash commands and persistent goal controls.
  await page.locator('#prompt').fill('/goal');
  assert.equal(await page.locator('#slashCommands').isVisible(), true);
  await page.locator('#prompt').press('Enter');
  assert.equal(await page.locator('#goalDialog').isVisible(), true);
  await page.locator('#goalObjective').fill('Deliver the full coffee campaign with verified files');
  await page.locator('#goalBudget').fill('2000');
  await page.locator('#saveGoal').click();
  await until(() => session.submissions === 3);
  await until(() => page.locator('#goalCard').textContent().then(text => text.includes('Deliver the full coffee campaign')));
  await page.locator('#prompt').fill('Preserve this draft while paused');
  await page.locator('#prompt').press('Escape');
  await until(() => page.locator('#recoveryPanel').textContent().then(text => text.includes('已暂停')));
  assert.equal(session.interrupts, 1);
  assert.equal(await page.locator('#prompt').inputValue(), 'Preserve this draft while paused');
  await page.locator('#resumeTask').click();
  await until(() => session.submissions === 4);
  await until(() => page.locator('#pauseBtn').isVisible());

  // A tool approval remains explicit and is sent to the original Session.
  const tool = ark.emit(session, { type: 'agent.tool_use', name: 'video_generate', input: { prompt: 'Coffee at sunrise' } });
  ark.finish(session, false, { text: 'Please approve video creation', stopReason: 'requires_action', eventIds: [tool.id] });
  await until(() => page.locator('#approvalPanel').isVisible());
  assert.equal(await page.locator('#runBtn').isEnabled(), false);
  await page.locator('[data-confirm][data-allow="true"]').click();
  await until(() => session.confirmations.length === 1 && session.streams >= 5 && session.ready);
  ark.finish(session, false, { text: '## Delivered\nThe campaign is complete.\n<<GOAL_COMPLETE>>', usage: { input_tokens: 300, output_tokens: 150 } });
  await until(() => page.locator('#goalCard').textContent().then(text => text.includes('已完成')));
  assert.equal(await page.locator('#messageTimeline').textContent().then(text => text.includes('<<GOAL_COMPLETE>>')), false);
  assert.equal(session.submissions, 4);

  // Session title, pin and archive are real persisted state.
  await page.locator('a[data-view="history"]').click();
  await page.locator(`[data-manage-task="${first.id}"]`).click();
  await page.locator('#threadTitle').fill('Coffee campaign');
  await page.locator('#threadForm button[type="submit"]').click();
  assert.equal((await request(`/api/tasks/${first.id}`)).task.title, 'Coffee campaign');
  await page.locator(`[data-manage-task="${first.id}"]`).click();
  await page.locator('#pinThread').click();
  assert.equal((await request(`/api/tasks/${first.id}`)).task.pinned, true);
  await page.locator(`[data-manage-task="${first.id}"]`).click();
  await page.locator('#archiveThread').click();
  await until(() => page.locator(`#recentTasks [data-task="${first.id}"]`).count().then(count => count === 0));
  await page.locator('#showArchived').check();
  await page.locator(`#historyList [data-task="${first.id}"]`).click();
  await until(() => page.locator('#pageTitle').textContent().then(text => text === 'Coffee campaign'));

  const screenshots = process.env.VISIONARY_SCREENSHOT;
  if (screenshots) {
    await mkdir(path.dirname(screenshots), { recursive: true });
    await page.screenshot({ path: `${screenshots}-conversation-desktop.png`, animations: 'disabled' });
  }
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}`);
    const send = await page.locator('#runBtn').boundingBox();
    assert.ok(send.x >= 0 && send.x + send.width <= width && send.y + send.height <= 844, `send in viewport at ${width}`);
    if (screenshots && width === 390) await page.screenshot({ path: `${screenshots}-conversation-mobile.png`, animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
});
