import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');

test('video delivery shows and exports each actual prompt and cgt-id, excludes references and survives historical recovery', async t => {
  const ark = await mockArk(t);
  const env = { ARK_API_KEY: 'test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_VIDEO_MODEL: 'test-seedance', ARK_BASE_URL: ark.baseUrl };
  const first = await startServer(t, env);
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://files.test/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.goto(first.baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  await page.locator('#composerFileInput').setInputFiles({ name: '参考图片.png', mimeType: 'image/png', buffer: Buffer.from('test image') });
  await until(() => page.locator('#attachments').textContent().then(text => text.includes('已添加参考')));
  await page.locator('#prompt').fill('用参考图制作两段视频。');
  const submission = page.waitForResponse(response => response.url().endsWith('/api/creative') && response.request().method() === 'POST');
  await page.locator('#runBtn').click();
  const { task } = await (await submission).json();
  const session = await until(() => [...ark.sessions.values()].find(value => value.submissions === 1));
  const prompts = ['镜头一：海边日出。\n保留自然光影。<script>window.videoXss = true</script>', '镜头二：风吹过海面。\n保留完整提示词，最后缓缓拉远。'];
  const calls = [];
  for (let index = 0; index < prompts.length; index++) {
    const call = ark.emit(session, { type: 'agent.custom_tool_use', name: 'generate_video_without_watermark', input: {
      prompt: prompts[index], asset_ids: task.assetIds, duration: 5, ratio: '16:9', resolution: '720p', generate_audio: false, output_path: `/mnt/session/outputs/clip-${index + 1}.mp4`
    } });
    calls.push(call.id);
    session.status = 'idle';
    ark.emit(session, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [call.id] } });
    await until(() => session.customResults.length === index + 1);
    const result = JSON.parse(session.customResults[index].content[0].text);
    assert.equal(result.prompt, prompts[index]);
    assert.equal(result.cgt_id, `video-test-${index + 1}`);
  }
  ark.finish(session, false, { text: '两段视频已生成。' });
  await until(() => page.locator('.video-metadata').count().then(count => count === 3));
  const expectMetadata = async () => {
    assert.deepEqual(await page.locator('.video-prompt').allTextContents(), [...prompts, '历史记录未保存生成提示词']);
    assert.deepEqual(await page.locator('.video-cgt-id').allTextContents(), ['video-test-1', 'video-test-2', '未记录']);
    assert.equal(await page.locator('#outputFiles img').count(), 0);
    assert.equal(await page.locator('#outputFiles script').count(), 0);
    assert.equal(await page.evaluate(() => window.videoXss), undefined);
  };
  await expectMetadata();
  await page.locator('#copyBtn').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (let index = 0; index < prompts.length; index++) {
    assert.ok(copied.includes(`cgt-id：video-test-${index + 1}\n视频提示词：\n${prompts[index]}`));
  }
  assert.ok(!copied.includes('参考图片.png'));
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const downloaded = await downloadEvent;
  assert.equal(await readFile(await downloaded.path(), 'utf8'), copied);

  const prefix = process.env.VISIONARY_SCREENSHOT;
  if (prefix) await mkdir(path.dirname(prefix), { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.locator('#result').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.video-metadata').first().evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (prefix) await page.screenshot({ path: `${prefix}-video-${width}.png`, animations: 'disabled' });
  }
  const exited = once(first.child, 'exit');
  first.child.kill('SIGTERM');
  await exited;
  const saved = JSON.parse(await readFile(path.join(first.dataDir, 'tasks.json'), 'utf8'));
  const stored = saved.find(value => value.id === task.id);
  const promptlessJob = stored.assetVideoJobs[calls[0]];
  delete promptlessJob.prompt;
  delete promptlessJob.file.prompt;
  delete promptlessJob.file.cgt_id;
  stored.files.push(
    { id: 'duplicate', filename: 'clip-1.mp4', mime_type: 'video/mp4', download_url: 'https://files.test/registered.mp4' },
    { id: 'reference-copy', filename: '参考图片.png', mime_type: 'image/png', download_url: 'https://files.test/reference.png' },
    { id: 'staging-copy', filename: 'converted-reference.jpg', mime_type: 'image/jpeg', download_url: 'https://files.test/reference.jpg' }
  );
  stored.executionSteps.push({ id: 'staging-inspection', output: [{ type: 'text', text: '/mnt/session/outputs/.staging/converted-reference.jpg' }] });
  await writeFile(path.join(first.dataDir, 'tasks.json'), JSON.stringify(saved));
  const second = await startServer(t, { ...env, VISIONARY_DATA_DIR: first.dataDir });
  await page.addInitScript(id => localStorage.setItem('visionary-active-task', id), task.id);
  await page.goto(second.baseUrl);
  await until(() => page.locator('.video-metadata').count().then(count => count === 3));
  await expectMetadata();
  const recovered = (await second.request(`/api/tasks/${task.id}`)).task;
  assert.equal(recovered.files.length, 3);
  assert.equal(recovered.assetVideoJobs[calls[0]].prompt, prompts[0]);
  assert.equal(ark.videoRequests.length, 2);
  assert.equal(session.submissions, 1);
  assert.deepEqual(errors, []);
});
