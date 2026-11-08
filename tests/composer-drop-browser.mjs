import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6MsAAAAASUVORK5CYII=', 'base64');

async function openStudio(t, arkOptions) {
  const ark = await mockArk(t, arkOptions);
  const server = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  return { ...server, ark, page, errors };
}

async function fileTransfer(page, files) {
  return page.evaluateHandle(files => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type, lastModified: 1 }));
    return data;
  }, files);
}

test('dropping multiple references on the composer uploads, attaches and submits them without changing the draft', async t => {
  const { page, ark, request, errors } = await openStudio(t);
  const draft = '用这些参考素材制作一支短片。';
  await page.locator('#prompt').fill(draft);
  const dataTransfer = await fileTransfer(page, [
    { name: '图片1_教室.png', type: 'image/png', bytes: [...image] },
    { name: '图片2_艾拉.png', type: 'image/png', bytes: [...image] },
    { name: 'reference.mp4', type: 'video/mp4', bytes: [1, 2, 3] },
    { name: 'reference.mp3', type: 'audio/mpeg', bytes: [4, 5, 6] }
  ]);
  await page.locator('#composer').dispatchEvent('dragenter', { dataTransfer });
  assert.equal(await page.locator('.composer-drop-hint').isVisible(), true);
  // Moving between nested controls must keep the drop indication visible.
  await page.locator('#prompt').dispatchEvent('dragenter', { dataTransfer });
  await page.locator('#composer').dispatchEvent('dragleave', { dataTransfer });
  const acceptedDrag = await page.locator('#prompt').evaluate((element, dataTransfer) => {
    const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, dataTransfer);
  assert.equal(await page.locator('.composer-drop-hint').isVisible(), true);
  assert.equal(acceptedDrag, true);
  const screenshots = process.env.VISIONARY_SCREENSHOT;
  if (screenshots) {
    await mkdir(path.dirname(screenshots), { recursive: true });
    await page.screenshot({ path: `${screenshots}-composer-drag-dark.png`, animations: 'disabled' });
    await page.locator('#themeToggle').click();
    await page.screenshot({ path: `${screenshots}-composer-drag-light.png`, animations: 'disabled' });
  }
  await page.locator('#prompt').dispatchEvent('drop', { dataTransfer });
  await until(() => page.locator('#attachments .attachment-status').allTextContents().then(statuses => statuses.length === 4 && statuses.every(status => status.includes('已添加参考'))));
  assert.equal(await page.locator('.composer-drop-hint').isHidden(), true);
  assert.equal(await page.locator('#prompt').inputValue(), draft);
  assert.equal(await page.locator('#attachmentCount').textContent(), '(4)');
  const assets = (await request('/api/assets')).items;
  assert.equal(assets.length, 4);
  assert.ok(assets.every(asset => asset.collection === 'reference' && asset.arkFileId));
  if (screenshots) await page.screenshot({ path: `${screenshots}-composer-attached-light.png`, animations: 'disabled' });
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  await page.locator('#runBtn').click();
  const response = await accepted;
  assert.equal(response.status(), 202);
  const submitted = response.request().postDataJSON();
  assert.equal(submitted.prompt, draft);
  assert.deepEqual(new Set(submitted.assetIds), new Set(assets.map(asset => asset.id)));
  await until(() => [...ark.sessions.values()].some(session => session.submissions === 1));
  assert.equal(ark.sessions.size, 1);
  assert.deepEqual(errors, []);
});

test('file drops preserve failure recovery, reject invalid files, leave text drags native and keep library drops working', async t => {
  const { page, request, errors } = await openStudio(t, { uploadFailures: 1 });
  await page.locator('#prompt').fill('Keep this draft');
  const textDrag = await page.evaluateHandle(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'Dragged words'); return data;
  });
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const prevented = await page.locator('#prompt').evaluate((element, { type, dataTransfer }) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
      element.dispatchEvent(event); return event.defaultPrevented;
    }, { type, dataTransfer: textDrag });
    assert.equal(prevented, false, `plain text ${type} keeps browser behavior`);
  }
  assert.equal(await page.locator('.composer-drop-hint').isHidden(), true);

  const dataTransfer = await fileTransfer(page, [{ name: 'retry.png', type: 'image/png', bytes: [...image] }]);
  await page.locator('#composer').dispatchEvent('dragenter', { dataTransfer });
  await page.locator('#composer').dispatchEvent('dragleave', { dataTransfer });
  assert.equal(await page.locator('.composer-drop-hint').isHidden(), true);
  await page.locator('#composer').dispatchEvent('dragenter', { dataTransfer });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('.composer-drop-hint').isHidden(), true);
  for (const type of ['dragover', 'drop']) {
    const prevented = await page.locator('#studioWelcome').evaluate((element, { type, dataTransfer }) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
      element.dispatchEvent(event); return event.defaultPrevented;
    }, { type, dataTransfer });
    assert.equal(prevented, true, `outside file ${type} cannot replace the page`);
  }
  assert.equal(await page.locator('#attachments .attachment').count(), 0);

  const invalid = await fileTransfer(page, [
    { name: 'unsupported.zip', type: 'application/zip', bytes: [1] },
    { name: 'empty.png', type: 'image/png', bytes: [] }
  ]);
  await page.locator('#composer').dispatchEvent('drop', { dataTransfer: invalid });
  assert.equal(await page.locator('#attachments .attachment').count(), 0);
  assert.match(await page.locator('#toast').textContent(), /大于 0/);
  await page.locator('#composer').dispatchEvent('drop', { dataTransfer });
  await until(() => page.locator('#attachments .attachment.failed').count().then(count => count === 1));
  assert.equal(await page.locator('#runBtn').isDisabled(), true);
  const [saved] = (await request('/api/assets')).items;
  await page.locator('.attachment-retry').click();
  await until(() => page.locator('#attachments').textContent().then(text => text.includes('已添加参考')));
  const synced = (await request('/api/assets')).items;
  assert.equal(synced.length, 1);
  assert.equal(synced[0].id, saved.id);
  assert.ok(synced[0].arkFileId);
  assert.equal(await page.locator('#runBtn').isEnabled(), true);
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft');
  await page.locator('.attachment-remove').click();
  assert.equal(await page.locator('#attachments .attachment').count(), 0);

  await page.locator('a[data-view="assets"]').click();
  await page.locator('[data-collection="reference"]').click();
  await page.locator('#dropzone').dispatchEvent('dragover', { dataTransfer });
  await page.locator('#dropzone').dispatchEvent('drop', { dataTransfer });
  assert.match(await page.locator('#selectedFiles').textContent(), /retry.png/);
  assert.equal(await page.locator('#uploadAction').isEnabled(), true);
  assert.deepEqual(errors, []);
});
