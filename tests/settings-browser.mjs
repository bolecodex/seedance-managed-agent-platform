import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mockArk, startServer, until } from './helpers/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VISIONARY_PLAYWRIGHT_PATH || 'playwright');

test('settings can be saved, tested, cleared and restored without returning credentials to the browser', async t => {
  const ark = await mockArk(t);
  const { baseUrl, request } = await startServer(t, { ARK_API_KEY: 'inherited-ui-secret' });
  const browser = await chromium.launch({ headless: true, ...(process.env.VISIONARY_CHROMIUM_PATH ? { executablePath: process.env.VISIONARY_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.locator('#settingsButton').click();
  await until(() => page.locator('#configFields').isEnabled());
  const key = page.locator('#setting-ARK_API_KEY');
  const keyAction = page.locator('[data-secret-action="ARK_API_KEY"]');
  assert.equal(await key.inputValue(), '');
  assert.equal(await key.isDisabled(), true);
  assert.ok(!(await page.content()).includes('inherited-ui-secret'));
  assert.equal(await page.locator('#saveConfig').isDisabled(), true);
  await keyAction.selectOption('replace');
  await key.fill('saved-ui-secret');
  await page.locator('[data-reveal-secret="ARK_API_KEY"]').click();
  assert.equal(await key.getAttribute('type'), 'text');
  await page.locator('[data-reveal-secret="ARK_API_KEY"]').click();
  await page.locator('#setting-ARK_BASE_URL').fill(ark.baseUrl);
  await page.locator('[data-config-tab="agent"]').click();
  await page.locator('#setting-ARK_AGENT_ID').fill('test-agent');
  await page.locator('#setting-ARK_ENVIRONMENT_ID').fill('test-environment');
  await page.locator('#setting-ARK_IMAGE_MODEL').fill('custom-image-model');
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#configMessage').textContent().then(text => text.includes('已保存并生效')));
  assert.equal((await request('/api/config')).configured, true);
  assert.equal(await key.inputValue(), '');
  assert.ok(!(await page.content()).includes('saved-ui-secret'));
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes('ui-secret'));
  await page.locator('#testConfig').click();
  await until(() => page.locator('#configMessage').textContent().then(text => text.includes('连接测试通过')));
  assert.equal(ark.sessions.size, 0);

  // An unrelated edit preserves the saved key. Bad inputs stay editable.
  await page.locator('[data-config-tab="connection"]').click();
  await page.locator('#setting-ARK_BASE_URL').fill('not-a-url');
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#configMessage').textContent().then(text => text.includes('有效的完整 URL')));
  assert.equal(await page.locator('#setting-ARK_BASE_URL').inputValue(), 'not-a-url');
  await page.locator('#setting-ARK_BASE_URL').fill(ark.baseUrl);
  await page.locator('#setting-ARK_PROJECT_NAME').fill('ui-project');
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#configMessage').textContent().then(text => text.includes('已保存并生效')));
  assert.equal((await request('/api/settings')).fields.find(field => field.key === 'ARK_API_KEY').configured, true);
  await keyAction.selectOption('clear');
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('未配置 Key')));
  assert.equal((await request('/api/config')).filesApiConfigured, false);
  await keyAction.selectOption('inherit');
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#connectionText').textContent().then(text => text.includes('配置就绪')));
  assert.equal(await key.inputValue(), '');

  // All advanced settings are reachable and client validation selects the tab.
  await page.locator('[data-config-tab="assets"]').click();
  await page.locator('[data-secret-action="ARK_ACCESS_KEY"]').selectOption('replace');
  await page.locator('#setting-ARK_ACCESS_KEY').fill('ui-access-secret');
  await page.locator('[data-secret-action="ARK_SECRET_KEY"]').selectOption('replace');
  await page.locator('#setting-ARK_SECRET_KEY').fill('ui-signing-secret');
  await page.locator('[data-config-tab="advanced"]').click();
  await page.locator('#setting-ARK_ASSET_API_URL').fill(ark.baseUrl);
  await page.locator('#setting-MAX_CONCURRENT_TASKS').fill('0');
  await page.locator('[data-config-tab="connection"]').click();
  await page.locator('#saveConfig').click();
  assert.equal(await page.locator('[data-config-tab="advanced"]').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#configMessage').textContent(), /1–32/);
  await page.locator('#setting-MAX_CONCURRENT_TASKS').fill('4');
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#saveConfig').isDisabled());
  assert.equal((await request('/api/config')).avatarLibraryConfigured, true);

  // Unsaved credentials are removed from the DOM on close, and escape keeps
  // the creation composer intact while the settings dialog is open.
  await page.locator('[data-config-tab="connection"]').click();
  await keyAction.selectOption('replace'); await key.fill('discarded-ui-secret');
  page.once('dialog', dialog => dialog.accept());
  await key.press('Escape');
  assert.equal(await page.locator('#configDialog').isVisible(), false);
  assert.equal(await page.locator('#configFields input').count(), 0);
  await page.locator('#settingsButton').click();
  await until(() => page.locator('#configFields').isEnabled());
  assert.equal(await key.inputValue(), '');
  assert.equal((await request('/api/settings')).fields.find(field => field.key === 'MAX_CONCURRENT_TASKS').value, '4');

  // Two open settings windows cannot silently overwrite one another.
  const other = await context.newPage();
  await other.goto(baseUrl); await other.locator('#settingsButton').click();
  await until(() => other.locator('#configFields').isEnabled());
  await page.locator('#setting-ARK_PROJECT_NAME').fill('newer-project'); await page.locator('#saveConfig').click();
  await until(() => page.locator('#configMessage').textContent().then(text => text.includes('已保存并生效')));
  await other.locator('#setting-ARK_PROJECT_NAME').fill('stale-project'); await other.locator('#saveConfig').click();
  await until(() => other.locator('#configMessage').textContent().then(text => text.includes('其他页面更新')));
  await other.close();

  // Desktop, tablet and narrow mobile layouts fit the viewport in both themes.
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 740 : 1000 });
      for (const group of ['connection', 'agent', 'assets', 'advanced']) {
        await page.locator(`[data-config-tab="${group}"]`).click();
        const overflow = await page.locator('#configDialog').evaluate(element => {
          const body = element.querySelector('.config-body');
          const rect = element.getBoundingClientRect();
          return { width: element.scrollWidth - element.clientWidth, body: body.scrollWidth - body.clientWidth, left: rect.left, right: rect.right, window: innerWidth, footerVisible: element.querySelector('.config-footer').getBoundingClientRect().bottom <= innerHeight };
        });
        assert.ok(overflow.width <= 1 && overflow.body <= 1 && overflow.left >= 0 && overflow.right <= overflow.window && overflow.footerVisible, JSON.stringify({ theme, width, group, overflow }));
      }
      if (process.env.VISIONARY_SCREENSHOT && [1440, 390].includes(width)) {
        await page.locator('[data-config-tab="connection"]').click();
        const filename = `${process.env.VISIONARY_SCREENSHOT}-settings-${theme}-${width}.png`;
        await mkdir(path.dirname(filename), { recursive: true });
        await page.screenshot({ path: filename, fullPage: true });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#resetConfig').click();
  assert.match(await page.locator('#configMessage').textContent(), /预览/);
  await page.locator('#saveConfig').click();
  await until(() => page.locator('#configMessage').textContent().then(text => text.includes('已保存并生效')));
  const reset = await request('/api/settings');
  assert.equal(reset.fields.find(field => field.key === 'ARK_API_KEY').source, 'environment');
  assert.equal(reset.fields.find(field => field.key === 'ARK_ACCESS_KEY').configured, false);
  assert.equal(reset.fields.find(field => field.key === 'ARK_PROJECT_NAME').value, 'yingke');
  assert.deepEqual(errors, []);
});
