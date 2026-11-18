import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6MsAAAAASUVORK5CYII=', 'base64');
// Three seconds of solid color, VP8/WebM, 160 × 90; kept inline to avoid external media dependencies.
const videoFixture = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAUDEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggTt7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiECncAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgHz9p3vgBUnZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgkLCBoLqBWpqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WIB8/ad74AVJ1nyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAzLjAwMDAwMDAwMAAfQ7Z1Q0HngQCjzYEAAICwBQCdASqgAFoAAEcIhYWIhYSIAgICdaoCBnmVphqqTXcQ6qk13EOqpNdxDqqTXcQ6qk13EN4A/ucw//hWt7PYHmq/Fb6gZpAAo5iBAGQAEQIAARAQABgAGFgv9AAIgIEAAACjmIEAyAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQEsABECAAEQEAAYABhYL/QACICBAAAAo5iBAZAAEQIAARAQABgAGFgv9AAIgIEAAACjmIEB9AARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQJYABECAAEQEAAYABhYL/QACICBAAAAo5eBArwA8QEAARAQFGAAYWC/0AAiAgQAAKOYgQMgABECAAEQEAAYABhYL/QACICBAAAAo5iBA4QAEQIAARAQABgAGFgv9AAIgIEAAACjmIED6AARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQRMABECAAEQEAAYABhYL/QACICBAAAAo5iBBLAAEQIAARAQABgAGFgv9AAIgIEAAACjmIEFFAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQV4ABECAAEQEAAYABhYL/QACICBAAAAo5iBBdwAEQIAARAQABgAGFgv9AAIgIEAAACjmIEGQAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQakABECAAEQEAAYABhYL/QACICBAAAAo5eBBwgA8QEAARAQFGAAYWC/0AAiAgQAAKOYgQdsABECAAEQEAAYABhYL/QACICBAAAAo5iBB9AAEQIAARAQABgAGFgv9AAIgIEAAACjmIEINAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQiYABECAAEQEAAYABhYL/QACICBAAAAo5iBCPwAEQIAARAQABgAGFgv9AAIgIEAAACjmIEJYAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQnEABECAAEQEAAYABhYL/QACICBAAAAo5iBCigAEQIAARAQABgAGFgv9AAIgIEAAACjmIEKjAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQrwABECAAEQEAAYABhYL/QACICBAAAAo5eBC1QA8QEAARAQFGAAYWC/0AAiAgQAABxTu2uRu4+zgQC3iveBAfGCAabwgQM=', 'base64');

async function studio(t, { running = false } = {}) {
  const ark = await mockArk(t);
  const server = await startServer(t, { ARK_API_KEY: 'test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const upload = async (name, body = image) => {
    const response = await fetch(`${server.baseUrl}/api/uploads`, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name), 'X-Collection': 'reference' }, body });
    assert.equal(response.status, 201);
    return (await response.json()).item;
  };
  const assets = [await upload('房间参考.png'), await upload('房间视频.mp4'), await upload('设计说明.txt', Buffer.from('设计说明'))];
  const files = [
    { filename: '客厅效果图.png', mime_type: 'image/png', download_url: 'https://files.test/room.png' },
    { filename: '<img onerror="window.previewXss=true">.png', mime_type: 'image/png', download_url: 'https://files.test/detail.png' },
    { filename: '空间漫游.webm', mime_type: 'video/webm', download_url: 'https://files.test/tour.webm', prompt: '空间漫游', cgt_id: 'test-video' },
    { filename: '过期图片.png', mime_type: 'image/png', download_url: 'https://files.test/expired.png' },
    { filename: '配乐.mp3', mime_type: 'audio/mpeg', download_url: 'https://files.test/music.mp3' },
    { filename: '设计说明.txt', mime_type: 'text/plain', download_url: 'https://files.test/notes.txt' }
  ];
  const task = { id: 'preview-test', title: '中古孟菲斯空间设计', prompt: '查看空间设计', status: 'completed', mode: 'agent', revision: 1, result: '创作交付', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [{ id: 'user-preview', role: 'user', text: '参考这些素材设计房间', assetIds: assets.map(item => item.id) }], files, executionSteps: [{ id: 'tool-preview', kind: 'tool', name: 'read', status: 'completed', output: [{ type: 'image', title: '工具图片', source: { url: files[0].download_url } }, { type: 'video', title: '工具视频', source: { url: files[2].download_url } }] }] };
  if (running) { task.status = 'running'; task.connection = 'connected'; }
  const mutations = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
  await page.route('**/api/tasks', route => route.fulfill({ json: { items: [task] } }));
  await page.route('**/api/tasks/preview-test', route => route.fulfill({ json: { task } }));
  await page.route('**/api/tasks/preview-test/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }));
  await page.route('https://files.test/**', route => {
    const url = route.request().url();
    return route.fulfill({ status: url.includes('expired') ? 404 : 200, headers: { 'Accept-Ranges': 'bytes' }, contentType: url.endsWith('.webm') ? 'video/webm' : 'image/png', body: url.includes('expired') ? Buffer.from('missing') : url.endsWith('.webm') ? videoFixture : image });
  });
  await page.addInitScript(({ task, ids }) => {
    localStorage.setItem('visionary-active-task', task);
    localStorage.setItem(`visionary-draft:${task}`, JSON.stringify({ text: '尚未发送的草稿', selected: ids, mode: 'agent' }));
  }, { task: task.id, ids: assets.map(item => item.id) });
  await page.goto(server.baseUrl);
  await until(() => running ? page.locator('.message-references a').count().then(count => count === assets.length) : page.locator('#outputFiles .output-card').count().then(count => count === files.length));
  return { ...server, ark, page, assets, task, mutations, dialog: page.locator('#mediaPreviewDialog') };
}

test('generated images open in a modal gallery, preserve originals and drafts, support keyboard and cleanly recover errors', async t => {
  const { page, dialog, mutations } = await studio(t);
  const first = page.locator('#outputFiles .output-image-preview').first();
  await first.click();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.locator('#mediaPreviewTitle').textContent(), '客厅效果图.png');
  assert.equal(await page.locator('#mediaPreviewCount').textContent(), '图片 · 1 / 4');
  await until(() => page.locator('#mediaPreviewStatus').isHidden());
  assert.equal(await page.locator('#previousMediaPreview').isDisabled(), true);
  assert.equal(await page.locator('#mediaPreviewOriginal').getAttribute('href'), 'https://files.test/room.png');
  assert.equal(page.context().pages().length, 1);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#mediaPreviewCount').textContent(), '图片 · 2 / 4');
  assert.equal(await page.locator('#mediaPreviewTitle img').count(), 0);
  assert.equal(await page.evaluate(() => window.previewXss), undefined);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#mediaPreviewContent video').getAttribute('controls'), '');
  await page.keyboard.press('ArrowRight');
  await until(() => page.locator('#mediaPreviewStatus').textContent().then(text => text.includes('预览加载失败')));
  assert.equal(await page.locator('#nextMediaPreview').isDisabled(), true);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await until(() => page.locator('#mediaPreviewStatus').isHidden());
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  await until(() => page.locator('#mediaPreviewContent').innerHTML().then(html => html === ''));
  assert.equal(await first.evaluate(element => document.activeElement === element), true);
  assert.equal(await page.locator('#prompt').inputValue(), '尚未发送的草稿');
  assert.equal(await page.locator('#outputFiles .output-card > a[target="_blank"]').count(), 6);
  assert.equal(await page.locator('#outputFiles audio[controls]').count(), 1);
  await first.press('Enter');
  await until(() => dialog.isVisible());
  await page.locator('#closeMediaPreview').click();
  await until(() => dialog.isHidden());
  assert.deepEqual(mutations, [], 'previewing never sends requests to mutate tasks or generate new media');
});

test('references, composer attachments, tool results and library thumbnails share the viewer and retain document links', async t => {
  const { page, dialog, assets, mutations } = await studio(t);
  const references = page.locator('.message-references');
  await references.locator('a').first().click();
  await until(() => dialog.isVisible());
  assert.equal(await page.locator('#mediaPreviewCount').textContent(), '图片 · 1 / 2');
  await page.locator('#nextMediaPreview').click();
  assert.equal(await page.locator('#mediaPreviewTitle').textContent(), '房间视频.mp4');
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  assert.equal(await references.locator('a').last().getAttribute('data-media-preview'), null);
  assert.equal(await references.locator('a').last().getAttribute('target'), '_blank');
  await page.locator('#attachments .attachment-preview').first().click();
  assert.equal(await page.locator('#mediaPreviewCount').textContent(), '图片 · 1 / 2');
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  const tool = page.locator('[data-step-id="tool-preview"]');
  await tool.locator('summary').click();
  await tool.locator('.execution-media').click();
  assert.equal(await page.locator('#mediaPreviewCount').textContent(), '图片 · 1 / 2');
  await page.locator('#nextMediaPreview').click();
  assert.equal(await page.locator('#mediaPreviewTitle').textContent(), '工具视频');
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  await page.locator('nav [data-view="assets"]').click();
  await page.locator('[data-collection="reference"]').click();
  const thumbnail = page.locator(`#assetList [data-media-preview="/api/assets/${assets[0].id}/content"]`).first();
  await thumbnail.click();
  assert.equal(await page.locator('#mediaPreviewCount').textContent(), '图片 · 2 / 2');
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  await page.locator(`#assetList a[data-media-preview="/api/assets/${assets[1].id}/content"]`).click();
  assert.equal(await page.locator('#mediaPreviewTitle').textContent(), '房间视频.mp4');
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  assert.equal(await page.locator('#assetList a.asset-preview:not([data-media-preview])').count(), 1);
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(mutations, []);
});

test('Escape closes a reference preview without pausing the running creation behind it', async t => {
  const { page, dialog, mutations } = await studio(t, { running: true });
  await page.locator('.message-references a').first().click();
  await until(() => dialog.isVisible());
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  assert.equal(await page.locator('#pauseBtn').isVisible(), true);
  assert.equal(await page.locator('#prompt').inputValue(), '尚未发送的草稿');
  assert.deepEqual(mutations, []);
});

test('viewer fits desktop and mobile in both themes, traps focus, closes on backdrop and releases playing video', async t => {
  const { page, dialog, mutations } = await studio(t);
  const inline = page.locator('#outputFiles video');
  await inline.scrollIntoViewIfNeeded();
  await until(() => inline.evaluate(video => video.readyState >= 2));
  await inline.evaluate(video => { video.currentTime = .25; video.volume = .35; video.playbackRate = .75; });
  await until(() => inline.evaluate(video => !video.seeking));
  await inline.evaluate(video => video.play());
  const at = await inline.evaluate(video => video.currentTime);
  await page.locator('#outputFiles .output-expand').click();
  const video = page.locator('#mediaPreviewContent video');
  await until(() => video.evaluate(video => video.readyState >= 2));
  await until(() => video.evaluate(video => video.currentTime > 0));
  assert.ok(await video.evaluate(video => video.currentTime) >= at, 'preview retains the inline playback position');
  assert.equal(await video.evaluate(video => video.volume), .35);
  assert.equal(await video.evaluate(video => video.playbackRate), .75);
  assert.equal(await inline.evaluate(video => video.paused), true);
  await video.evaluate(async video => { window.closedPreviewVideo = video; await video.play(); });
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  assert.equal(await page.evaluate(() => window.closedPreviewVideo.paused && !window.closedPreviewVideo.hasAttribute('src')), true);
  const box = await inline.boundingBox();
  await inline.click({ position: { x: box.width / 2, y: box.height / 3 } });
  await until(() => dialog.isVisible());
  await page.keyboard.press('Escape');
  await until(() => dialog.isHidden());
  const prefix = process.env.VISIONARY_SCREENSHOT;
  if (prefix) await mkdir(path.dirname(prefix), { recursive: true });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator('#outputFiles .output-image-preview').first().click();
      await until(() => page.locator('#mediaPreviewStatus').isHidden());
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844, `viewer fits ${width} ${theme}`);
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
      if (prefix && [1440, 390].includes(width)) await page.screenshot({ path: `${prefix}-preview-${width}-${theme}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await until(() => dialog.isHidden());
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#outputFiles .output-image-preview').first().click();
  await page.mouse.click(2, 2);
  await until(() => dialog.isHidden());
  assert.deepEqual(mutations, []);
});
