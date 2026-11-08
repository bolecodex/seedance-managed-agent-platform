import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6MsAAAAASUVORK5CYII=', 'base64');
const pasteShortcut = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

async function openStudio(t) {
  const ark = await mockArk(t);
  const server = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  const upload = async (name, body = image) => {
    const response = await fetch(`${server.baseUrl}/api/uploads`, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name), 'X-Collection': 'reference' }, body });
    assert.equal(response.status, 201);
    return (await response.json()).item;
  };
  const openTask = async task => {
    await page.reload();
    await page.locator(`#recentTasks [data-task="${task.id}"]`).click();
    await until(() => page.locator('.chat-user').count().then(count => count === 1));
    await until(() => page.locator('.message-references .message-asset-info b').first().textContent().then(name => name !== '参考素材 1'));
  };
  return { ...server, ark, context, page, upload, openTask };
}

async function readClipboard(page) {
  return page.evaluate(async () => {
    const result = {};
    for (const item of await navigator.clipboard.read()) for (const type of item.types) result[type] = await (await item.getType(type)).text();
    return result;
  });
}

test('copy and native paste carry the prompt and ordered media/document references to another tab, persist and submit without reuploading', async t => {
  const { page, context, baseUrl, request, ark, upload, openTask } = await openStudio(t);
  const assets = [];
  for (const [name, bytes] of [['图片1_教室.png', image], ['图片2_艾拉.png', image], ['参考视频.mp4', Buffer.from([1, 2, 3])], ['参考配音.mp3', Buffer.from([4, 5, 6])], ['分镜 & "设定".txt', Buffer.from('文档参考')]]) assets.push(await upload(name, bytes));
  const prompt = '  [生成目标]\n@图片1用于教室空间，@图片2用于艾拉形象。\n<script>window.copyXss = true</script>\n<<GOAL_COMPLETE>>  ';
  const ids = assets.map(item => item.id);
  const { task } = await request('/api/creative', { prompt, assetIds: ids });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  await openTask(task);
  assert.equal(await page.locator('.chat-user [data-copy-message]').getAttribute('title'), '复制提示词与引用素材');
  await page.locator('.chat-user [data-copy-message]').click();
  await until(() => page.locator('#toast').textContent().then(text => text === '已复制提示词与 5 份引用素材'));
  const clipboard = await readClipboard(page);
  assert.ok(clipboard['text/plain'].startsWith(prompt.trim()));
  assert.ok(clipboard['text/plain'].includes(assets[4].name));
  assert.ok(clipboard['text/plain'].includes(`${baseUrl}/api/assets/${ids[0]}/content`));
  assert.ok(clipboard['text/html'].includes('data-visionary-message'));
  assert.ok(clipboard['text/html'].includes('&lt;script&gt;'));

  const target = await context.newPage();
  await target.goto(baseUrl);
  await until(() => target.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  await target.locator('#newTask').click();
  // The rich clipboard itself carries the bundle; no shared storage is needed.
  await target.evaluate(() => localStorage.removeItem('visionary-copied-message'));
  await target.locator('#prompt').focus();
  await target.keyboard.press(pasteShortcut);
  await until(() => target.locator('#attachments .attachment').count().then(count => count === assets.length));
  const sentPrompt = task.messages[0].text;
  assert.equal(await target.locator('#prompt').inputValue(), sentPrompt);
  assert.deepEqual(await target.locator('#attachments .attachment-info b').allTextContents(), assets.map(item => item.name));
  assert.equal(await target.evaluate(() => window.copyXss), undefined);
  // Repeated paste inserts at the selection and keeps a single reference to each asset.
  await target.locator('#prompt').evaluate(element => element.select());
  await target.keyboard.press(pasteShortcut);
  assert.equal(await target.locator('#prompt').inputValue(), sentPrompt);
  assert.equal(await target.locator('#attachments .attachment').count(), assets.length);
  await target.reload();
  await until(() => target.locator('#attachments .attachment').count().then(count => count === assets.length));
  assert.equal(await target.locator('#prompt').inputValue(), sentPrompt);
  assert.deepEqual(await target.locator('#attachments .attachment-info b').allTextContents(), assets.map(item => item.name));
  if (process.env.VISIONARY_SCREENSHOT) {
    await mkdir(path.dirname(process.env.VISIONARY_SCREENSHOT), { recursive: true });
    await target.screenshot({ path: `${process.env.VISIONARY_SCREENSHOT}-message-copy-pasted.png`, animations: 'disabled' });
  }
  const accepted = target.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  await target.locator('#runBtn').click();
  const response = await accepted;
  assert.equal(response.status(), 202);
  assert.deepEqual(response.request().postDataJSON().assetIds, ids);
  assert.equal(response.request().postDataJSON().prompt, sentPrompt);
  assert.equal((await request('/api/assets')).items.length, assets.length);
});

test('text-only clipboard fallback keeps references after reload and ordinary text copy clears the bundle', async t => {
  const { page, request, ark, upload, openTask } = await openStudio(t);
  const asset = await upload('fallback.png');
  const { task } = await request('/api/creative', { prompt: '复制后继续编辑', assetIds: [asset.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  ark.finish(session, false, { text: '普通 **回复**\n<<GOAL_COMPLETE>>' });
  await openTask(task);
  await until(() => page.locator('.chat-assistant [data-copy-message]').count());
  await page.evaluate(() => { navigator.clipboard.write = async () => { throw new Error('Rich clipboard unsupported'); }; });
  await page.locator('.chat-user [data-copy-message]').click();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('已复制提示词')));
  assert.ok((await readClipboard(page))['text/plain'].includes(asset.name));
  await page.locator('#newTask').click();
  await page.reload();
  await page.locator('#prompt').focus();
  await page.keyboard.press(pasteShortcut);
  await until(() => page.locator('#attachments .attachment').count());
  assert.equal(await page.locator('#prompt').inputValue(), '复制后继续编辑');
  assert.deepEqual(await page.locator('#attachments .attachment-info b').allTextContents(), [asset.name]);

  await page.locator(`#recentTasks [data-task="${task.id}"]`).click();
  await page.locator('.chat-assistant [data-copy-message]').click();
  await until(() => page.locator('#toast').textContent().then(text => text === '已复制消息'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '普通 **回复**');
  assert.equal(await page.evaluate(() => localStorage.getItem('visionary-copied-message')), null);
  await page.locator('#newTask').click();
  await page.locator('.attachment-remove').click();
  await page.locator('#prompt').fill('前文|后文');
  await page.locator('#prompt').evaluate(element => element.setSelectionRange(2, 3));
  await page.keyboard.press(pasteShortcut);
  assert.equal(await page.locator('#prompt').inputValue(), '前文普通 **回复**后文');
  assert.equal(await page.locator('#attachments .attachment').count(), 0);
});

test('deleted references are reported, available references survive and foreign or malformed bundles stay as text', async t => {
  const { page, baseUrl, request, ark, upload, openTask } = await openStudio(t);
  const first = await upload('available.png'), second = await upload('deleted.png');
  const { task } = await request('/api/creative', { prompt: '仍然保留提示词', assetIds: [first.id, second.id] });
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  await openTask(task);
  await page.locator('.chat-user [data-copy-message]').click();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('已复制提示词')));
  assert.equal((await fetch(`${baseUrl}/api/assets/${second.id}`, { method: 'DELETE' })).status, 200);
  await page.locator('#newTask').click();
  await page.reload();
  await until(() => page.locator('#assetCount').textContent().then(text => text === '1'));
  await page.locator('#prompt').focus();
  await page.keyboard.press(pasteShortcut);
  await until(() => page.locator('#toast').textContent().then(text => text.includes('1 份引用素材已删除或暂不可用')));
  assert.equal(await page.locator('#prompt').inputValue(), task.messages[0].text);
  assert.deepEqual(await page.locator('#attachments .attachment-info b').allTextContents(), [first.name]);
  await page.locator('.attachment-remove').click();
  for (const bundle of [{ version: 1, origin: 'https://other.test', text: '不要恢复', assetIds: [first.id] }, { version: 1, origin: baseUrl, text: '不要恢复', assetIds: [null] }]) {
    await page.locator('#prompt').fill('');
    await page.evaluate(async bundle => {
      const div = document.createElement('div');
      div.setAttribute('data-visionary-message', JSON.stringify(bundle));
      div.textContent = '普通粘贴文本';
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['普通粘贴文本'], { type: 'text/plain' }), 'text/html': new Blob([div.outerHTML], { type: 'text/html' }) })]);
    }, bundle);
    await page.locator('#prompt').focus();
    await page.keyboard.press(pasteShortcut);
    assert.equal(await page.locator('#prompt').inputValue(), '普通粘贴文本');
    assert.equal(await page.locator('#attachments .attachment').count(), 0);
  }
});
