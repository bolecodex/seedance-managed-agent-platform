import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');

test('background generation stays independent of the composer, page and selected task', async t => {
  const ark = await mockArk(t);
  const { baseUrl, request } = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://files.test/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.goto(baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  const submit = async prompt => {
    await page.locator('#prompt').fill(prompt);
    const response = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
    await page.locator('#runBtn').click();
    const accepted = await response;
    assert.equal(accepted.status(), 202);
    const { task } = await accepted.json();
    await until(() => page.locator('#runBtn').isEnabled());
    return task;
  };
  const a = await submit('Browser task A');
  assert.equal((await request(`/api/tasks/${a.id}`)).task.status, 'running');
  assert.equal(await page.locator('#newTask').isEnabled(), true);
  assert.equal(await page.locator('#headerNewTask').isEnabled(), true);
  await page.locator('#newTask').click();
  assert.equal(await page.locator('#studioWelcome').isVisible(), true);
  assert.equal(await page.locator('#conversation').isVisible(), false);
  const b = await submit('Browser task B');
  await page.locator('#headerNewTask').click();
  const c = await submit('Browser task C');
  await until(async () => (await request(`/api/tasks/${c.id}`)).task.status === 'queued');
  await until(() => page.locator('#taskActivity').textContent().then(text => text.includes('2 个任务后台生成中') && text.includes('1 个任务排队中')));
  assert.equal(await page.locator('#newTask').isEnabled(), true);
  assert.match(await page.locator('#statusText').textContent(), /排队中/);

  await page.locator('#headerNewTask').click();
  await page.locator('#prompt').fill('Unsaved next task draft');
  let uploadCount = 0;
  await page.route('**/api/uploads', route => {
    uploadCount++;
    return route.fulfill({ status: 201, json: { item: { id: 'test-reference', name: 'reference.png', type: 'image/png', size: 10, collection: 'reference', arkFileId: 'file-reference', status: '已同步' } } });
  });
  await page.locator('#composerFileInput').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('test image') });
  await until(() => page.locator('#attachments').textContent().then(text => text.includes('已添加参考')));
  assert.equal(uploadCount, 1);
  assert.equal(await page.locator('#runBtn').isEnabled(), true);
  await page.locator(`#recentTasks [data-task="${a.id}"]`).click();
  await until(() => page.locator('#conversationPrompt').textContent().then(text => text === a.prompt));
  assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(await page.locator('#attachments').textContent(), '');

  await page.locator('a[data-view="assets"]').click();
  await until(() => page.locator('#assetsView').isVisible());
  const sessionA = [...ark.sessions.values()].find(session => session.title === a.prompt);
  ark.finish(sessionA);
  await until(async () => (await request(`/api/tasks/${a.id}`)).task.status === 'completed');
  await until(() => page.locator('#resultContent').textContent().then(text => text.includes(a.prompt)));
  assert.equal(await page.locator('#pageTitle').textContent(), '素材资产库');
  assert.equal(await page.locator('#prompt').inputValue(), '');
  await until(() => ark.sessions.size === 3);
  await page.locator('a[data-view="studio"]').click();
  const sessionB = [...ark.sessions.values()].find(session => session.title === b.prompt);
  const sessionC = [...ark.sessions.values()].find(session => session.title === c.prompt);

  // A slow older detail request must not replace a newer task or a fresh draft.
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  let capturedOld;
  await page.route(`**/api/tasks/${b.id}`, async route => {
    capturedOld = true; await oldResponse; await route.continue();
  });
  await page.locator(`#recentTasks [data-task="${b.id}"]`).click();
  await until(() => capturedOld);
  await page.locator(`#recentTasks [data-task="${c.id}"]`).click();
  await until(() => page.locator('#conversationPrompt').textContent().then(text => text === c.prompt));
  releaseOld();
  await page.unroute(`**/api/tasks/${b.id}`);
  await until(() => page.locator('#progress').isVisible());
  assert.equal(await page.locator('#conversationPrompt').textContent(), c.prompt);

  await page.locator('#headerNewTask').click();
  await page.locator('#prompt').fill('Keep this draft after a background failure');
  ark.finish(sessionB, true);
  await until(() => page.locator('#historyList').textContent().then(text => text.includes('未完成')));
  assert.equal(await page.locator('#conversation').isVisible(), false);
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft after a background failure');
  assert.equal(await page.locator('#newTask').isEnabled(), true);

  // Reload discovers active jobs and resumes observation without another POST.
  await page.reload();
  await until(() => page.locator('#taskActivity').isVisible());
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft after a background failure');
  assert.equal(await page.locator('#runBtn').isEnabled(), true);
  await page.locator(`#recentTasks [data-task="${c.id}"]`).click();
  await until(() => page.locator('#progress').isVisible());

  // Temporary polling failure is a retryable observation problem, not task failure.
  let failPoll = true;
  await page.route('**/api/tasks', route => failPoll ? route.fulfill({ status: 503, json: { error: 'temporary unavailable' } }) : route.continue());
  await until(() => page.locator('#taskActivity').textContent().then(text => text.includes('自动重试')));
  assert.equal(await page.locator('#runBtn').isEnabled(), true);
  assert.equal(await page.locator('#statusText').textContent(), 'Agent 正在创作');
  failPoll = false;
  ark.finish(sessionC);
  await until(() => page.locator('#resultContent').textContent().then(text => text === `Result for ${c.prompt}`), 12000);
  assert.equal(await page.locator('#outputFiles a').getAttribute('href'), `https://files.test/${sessionC.id}.mp4`);
  await until(() => page.locator('#taskActivity').isHidden());
  assert.ok([...ark.sessions.values()].every(session => session.submissions === 1));

  // Refreshing an old result may finish after the user starts a new task.
  let releaseRefresh;
  const refreshResponse = new Promise(resolve => { releaseRefresh = resolve; });
  let refreshing = false;
  await page.route(`**/api/tasks/${c.id}/refresh-outputs`, async route => { refreshing = true; await refreshResponse; await route.continue(); });
  await page.locator('#refreshOutputs').click();
  await until(() => refreshing);
  await page.locator('#headerNewTask').click();
  await page.locator('#prompt').fill('A new draft while outputs refresh');
  releaseRefresh();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('未重复调用生成')));
  assert.equal(await page.locator('#conversation').isVisible(), false);
  assert.equal(await page.locator('#prompt').inputValue(), 'A new draft while outputs refresh');
  assert.equal(ark.sessions.size, 3);
  assert.deepEqual(errors, []);

  // An accepted submission may return after the user has already opened a new draft.
  let releaseSubmission;
  const submissionResponse = new Promise(resolve => { releaseSubmission = resolve; });
  let submissionStarted = false;
  await page.route('**/api/creative', async route => { submissionStarted = true; await submissionResponse; await route.continue(); });
  await page.locator('#prompt').fill('Delayed submission');
  await page.locator('#runBtn').click();
  await until(() => submissionStarted);
  assert.equal(await page.locator('#runBtn').isEnabled(), false);
  assert.equal(await page.locator('#headerNewTask').isEnabled(), true);
  await page.locator('#headerNewTask').click();
  await page.locator('#prompt').fill('New draft before submission returns');
  releaseSubmission();
  await until(() => page.locator('#runBtn').isEnabled());
  await page.unroute('**/api/creative');
  await until(() => ark.sessions.size === 4 && [...ark.sessions.values()].at(-1).submissions === 1);
  assert.equal(await page.locator('#conversation').isVisible(), false);
  assert.equal(await page.locator('#prompt').inputValue(), 'New draft before submission returns');
  ark.finish([...ark.sessions.values()].at(-1));

  // Desktop and mobile keep the background status and composer in the viewport.
  const d = await submit('Browser task D');
  await page.locator('#headerNewTask').click();
  const screenshot = process.env.VISIONARY_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: `${screenshot}-desktop.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(() => page.locator('#sidebar').evaluate(element => element.getBoundingClientRect().right <= 1));
  assert.equal(await page.locator('#taskActivity').isVisible(), true);
  assert.equal(await page.locator('#runBtn').isVisible(), true);
  assert.equal(await page.locator('#runBtn').isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshot) await page.screenshot({ path: `${screenshot}-mobile.png`, animations: 'disabled' });
  // Closing the page leaves server-side generation alive and its result discoverable.
  await until(() => [...ark.sessions.values()].some(session => session.title === d.prompt && session.submissions === 1));
  await page.close();
  ark.finish([...ark.sessions.values()].find(session => session.title === d.prompt));
  await until(async () => (await request(`/api/tasks/${d.id}`)).task.status === 'completed');
  const reopened = await browser.newPage();
  await reopened.goto(`${baseUrl}/#history`);
  await until(() => reopened.locator('#historyList').textContent().then(text => text.includes(d.prompt) && text.includes('已完成')));
  assert.ok([...ark.sessions.values()].every(session => session.submissions === 1));
  assert.deepEqual(errors, []);
});
