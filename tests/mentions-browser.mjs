import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';
import { mentionToken } from '../public/mentions.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6MsAAAAASUVORK5CYII=', 'base64');

async function studio(t, arkOptions) {
  const ark = await mockArk(t, arkOptions);
  const server = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const upload = async (name, collection = 'reference') => {
    const response = await fetch(`${server.baseUrl}/api/uploads`, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name), 'X-Collection': collection }, body: image });
    assert.equal(response.status, 201);
    return (await response.json()).item;
  };
  const open = async () => {
    await page.goto(server.baseUrl);
    await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
    await until(() => page.locator('#libraryCount').textContent().then(text => Number(text) > 0));
  };
  return { ...server, ark, page, upload, open, prompt: page.locator('#prompt'), picker: page.locator('#mentionPicker') };
}

test('smart mentions search attached and library files, support keyboard and mouse, persist drafts and send actual references', async t => {
  const { page, prompt, picker, ark, upload, open } = await studio(t);
  const video = await upload('中古孟菲斯风格参考.mp4');
  const plan = await upload('平面图 1.png');
  await upload('空间音乐.mp3');
  await upload('设计需求.pdf');
  await open();
  await prompt.fill('我想设计中古孟菲斯风格的房子，@视频');
  await until(() => picker.isVisible());
  assert.equal(await picker.locator('[data-mention-id]').count(), 1);
  await prompt.press('Enter');
  const token = mentionToken(video);
  assert.equal(await prompt.inputValue(), `我想设计中古孟菲斯风格的房子，${token} `);
  assert.equal(await page.locator('#attachmentCount').textContent(), '(1)');
  assert.equal(await picker.isHidden(), true);
  assert.equal(ark.sessions.size, 0, 'Enter selects a reference without sending');

  await prompt.press('End');
  await prompt.press('@');
  assert.equal(await picker.locator('[data-mention-id]').first().getAttribute('data-mention-id'), video.id, 'attached references appear first');
  await prompt.press('ArrowDown');
  await prompt.press('ArrowUp');
  assert.equal(await picker.locator('[aria-selected="true"]').getAttribute('data-mention-id'), video.id);
  assert.equal(await prompt.getAttribute('aria-activedescendant'), await picker.locator('[aria-selected="true"]').getAttribute('id'));
  await prompt.press('Tab');
  assert.equal(await page.locator('#attachments .attachment').count(), 1, 'repeated mentions do not duplicate attachments');

  await prompt.press('End');
  await prompt.press('@');
  await picker.locator(`[data-mention-id="${plan.id}"]`).click();
  assert.equal(await page.locator('#attachments .attachment').count(), 2);
  assert.equal(await prompt.evaluate(element => document.activeElement === element), true);
  const draft = await prompt.inputValue();
  await page.reload();
  await until(() => page.locator('#attachments .attachment').count().then(count => count === 2));
  assert.equal(await prompt.inputValue(), draft);
  await prompt.focus();
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  await prompt.press('Enter');
  const response = await accepted;
  assert.equal(response.status(), 202);
  assert.deepEqual(response.request().postDataJSON().assetIds, [video.id, plan.id]);
  assert.equal(response.request().postDataJSON().prompt, draft.trim());
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  assert.equal(session.messages[0].content.filter(block => block.source?.type === 'file').length, 2);
  assert.match(session.messages[0].content[0].text, /用户在正文中通过 @ 明确引用此素材/);
  ark.finish(session);
});

test('mention caret editing, IME, unavailable files, duplicate names, removal and missing-reference recovery are safe', async t => {
  const { page, prompt, picker, ark, upload, open, baseUrl } = await studio(t, { uploadFailures: 1 });
  const failed = await upload('同步失败.png');
  const first = await upload('平面图.png');
  const second = await upload('平面图.png');
  const privateAsset = await upload('待审核.png', 'virtual-avatar');
  await open();
  await prompt.fill('设计房间 @');
  assert.equal(await picker.locator(`[data-mention-id="${failed.id}"]`).isDisabled(), true);
  assert.equal(await picker.locator(`[data-mention-id="${privateAsset.id}"]`).isDisabled(), true);
  await prompt.press('Escape');
  assert.equal(await picker.isHidden(), true);
  assert.equal(await prompt.inputValue(), '设计房间 @');
  await prompt.press('ArrowLeft');
  await prompt.press('ArrowRight');
  await until(() => picker.isVisible());
  await page.locator('#charCount').click();
  assert.equal(await picker.isHidden(), true);
  await prompt.fill('hello@example.com');
  assert.equal(await picker.isHidden(), true);

  await prompt.fill('参考@');
  await prompt.dispatchEvent('compositionstart');
  await prompt.evaluate(element => { element.value = '参考@平面'; element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
  assert.equal(await picker.isHidden(), true);
  await prompt.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(ark.sessions.size, 0);
  await prompt.dispatchEvent('compositionend');
  assert.equal(await picker.locator('[data-mention-id]').count(), 2);
  await picker.locator(`[data-mention-id="${first.id}"]`).click();
  const assets = [first, second];
  assert.equal(await prompt.inputValue(), `参考${mentionToken(first, assets)} `);
  await page.locator('.attachment-remove').click();
  assert.equal(await prompt.inputValue(), '参考 ');

  const middle = '采用@平面图作为布局，保留后面的要求';
  await prompt.fill(middle);
  await prompt.evaluate(element => element.setSelectionRange(5, 5));
  await until(() => picker.isVisible());
  await picker.locator(`[data-mention-id="${second.id}"]`).click();
  assert.equal(await prompt.inputValue(), `采用${mentionToken(second, assets)} 图作为布局，保留后面的要求`);

  await page.reload();
  await until(() => page.locator('#attachments .attachment').count().then(count => count === 1));
  await fetch(`${baseUrl}/api/assets/${second.id}`, { method: 'DELETE' });
  await page.reload();
  await prompt.focus();
  await until(() => page.locator('#attachments .attachment').count().then(count => count === 0));
  await prompt.press('Enter');
  await until(() => page.locator('#toast').textContent().then(text => text.includes('引用素材已删除')));
  assert.equal(ark.sessions.size, 0, 'missing references never silently send without their files');
  assert.match(await prompt.inputValue(), /平面图/);
  await prompt.fill('@找不到的文件');
  assert.equal(await picker.locator('.mention-empty').isVisible(), true);
  await prompt.press('Enter');
  assert.equal(ark.sessions.size, 0, 'Enter in empty results never sends by accident');
});

test('mention picker stays inside the viewport in both themes and narrow layouts and preserves slash commands', async t => {
  const { page, prompt, picker, upload, open } = await studio(t);
  await upload('中古孟菲斯风格参考.mp4');
  await upload('带装修房子视频.mp4');
  await upload('平面图1.png');
  await upload('平面图尺寸.png');
  const special = await upload('<img onerror=alert(1)>设计需求.pdf');
  await open();
  const screenshots = process.env.VISIONARY_SCREENSHOT;
  if (screenshots) await mkdir(path.dirname(screenshots), { recursive: true });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await prompt.fill('我想设计中古孟菲斯风格的房子，@');
      await until(() => picker.isVisible());
      const bounds = await picker.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 844, `picker fits ${width} ${theme}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await picker.locator('.mention-info img').count(), 0, 'file names are escaped');
      if (screenshots && [1440, 390].includes(width)) await page.screenshot({ path: `${screenshots}-mentions-${width}-${theme}.png`, animations: 'disabled' });
      await picker.locator(`[data-mention-id="${special.id}"]`).click();
      assert.equal(await picker.isHidden(), true);
    }
  }
  await prompt.fill('/');
  await prompt.press('ArrowDown');
  assert.equal(await page.locator('[data-command="/pause"]').getAttribute('aria-selected'), 'true');
  assert.equal(await picker.isHidden(), true);
  await prompt.press('Escape');
  assert.equal(await page.locator('#slashCommands').isHidden(), true);
});
