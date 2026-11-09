import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');

test('inspiration preserves drafts, supports undo, persists preferences and works with keyboard commands across layouts', async t => {
  const ark = await mockArk(t);
  const { baseUrl } = await startServer(t, { ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));

  const prompt = page.locator('#prompt');
  await prompt.fill('保留原来的创作想法');
  await page.locator('#preferencesToggle').click();
  await page.locator('[data-toggle="optimize"]').click();
  await page.locator('[data-toggle="versions"]').click();
  await page.locator('#closePreferences').click();
  await page.locator('[data-template="film"]').click();
  assert.equal(await page.locator('[data-template="film"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#composerContext').isVisible(), true);
  assert.equal(await page.locator('#ratioSummary').textContent(), '16:9');
  assert.equal(await page.locator('[data-toggle="optimize"]').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('[data-toggle="versions"]').getAttribute('aria-checked'), 'true');
  await page.locator('.toast-action').click();
  assert.equal(await prompt.inputValue(), '保留原来的创作想法');
  assert.equal(await page.locator('#composerContext').isVisible(), false);
  assert.equal(await page.locator('#ratioSummary').textContent(), '1:1');

  await page.locator('[data-template="product"]').click();
  await prompt.fill('继续编辑后的新想法');
  await page.locator('.toast-action').click();
  assert.equal(await prompt.inputValue(), '继续编辑后的新想法');
  await page.locator('#clearTemplate').click();
  assert.equal(await prompt.inputValue(), '继续编辑后的新想法');
  assert.equal(await page.locator('#composerContext').isVisible(), false);

  await page.locator('#refreshInspiration').click();
  assert.match(await page.locator('[data-template="product"] b').textContent(), /清晨/);
  assert.equal(await prompt.inputValue(), '继续编辑后的新想法');
  await page.locator('[data-template="product"]').click();
  const chosen = await prompt.inputValue();
  assert.match(chosen, /植物香氛/);
  await page.reload();
  await until(() => page.locator('#composerContext').isVisible());
  assert.equal(await prompt.inputValue(), chosen);
  assert.equal(await page.locator('#ratioSummary').textContent(), '4:3');
  assert.equal(await page.locator('[data-toggle="versions"]').getAttribute('aria-checked'), 'true');

  await prompt.fill('/');
  await prompt.press('ArrowDown');
  assert.equal(await page.locator('[data-command="/pause"]').getAttribute('aria-selected'), 'true');
  await prompt.press('ArrowUp');
  await prompt.press('Tab');
  assert.equal(await prompt.inputValue(), '/goal');
  await prompt.press('Enter');
  assert.equal(await page.locator('#goalDialog').isVisible(), true);
  await page.locator('#closeGoal').click();
  await prompt.fill('/');
  await prompt.press('Escape');
  assert.equal(await page.locator('#slashCommands').isVisible(), false);
  assert.equal(await prompt.inputValue(), '/');

  await prompt.fill('测试长会话的阅读位置');
  await prompt.press('Enter');
  await until(() => [...ark.sessions.values()][0]?.submissions === 1);
  const session = [...ark.sessions.values()][0];
  ark.finish(session, false, { text: '一段已经保存的创作回复，用于验证长会话滚动。\n'.repeat(100) });
  await until(() => page.locator('.chat-assistant').count().then(count => count === 1));
  await page.locator('#studioScroll').evaluate(element => element.scrollTop = 0);
  await until(() => page.locator('#jumpLatest').isVisible());
  await page.locator('#jumpLatest').click();
  await until(() => page.locator('#jumpLatest').isHidden());

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#themeToggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}`);
    const send = await page.locator('#runBtn').boundingBox();
    assert.ok(send.x >= 0 && send.x + send.width <= width && send.y + send.height <= 844, `send remains reachable at ${width}`);
    await page.locator('#preferencesToggle').click();
    assert.equal(await page.locator('#preferencesPanel').isVisible(), true);
    await page.locator('#closePreferences').press('Escape');
    assert.equal(await page.locator('#preferencesPanel').isVisible(), false);
    if (width <= 760) await page.locator('#sidebarOpen').click();
    await page.locator('#newTask').click();
    assert.equal(await page.locator('#studioWelcome').isVisible(), true);
    assert.equal(await page.evaluate(() => document.querySelector('#studioScroll').scrollWidth <= document.querySelector('#studioScroll').clientWidth), true, `welcome fits at ${width}`);
  }
  assert.equal(ark.sessions.size, 1, 'visual interactions do not create generation requests');
  assert.deepEqual(errors, []);
});
