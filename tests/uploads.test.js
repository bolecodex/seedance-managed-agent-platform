import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { mockArk, startServer } from './helpers/server.js';

test('keeps a locally saved reference and syncs that same file after a Files API failure', async t => {
  const ark = await mockArk(t, { uploadFailures: 1 });
  const { baseUrl, dataDir } = await startServer(t, {
    ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl
  });
  const contents = Buffer.from('reference image bytes');
  const upload = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('reference.png'), 'X-Collection': 'reference' },
    body: contents
  });
  assert.equal(upload.status, 201);
  const { item: saved } = await upload.json();
  assert.equal(saved.status, '本机已保存 · 方舟同步失败');
  assert.match(saved.error, /temporary upload failure/);
  assert.equal(saved.arkFileId, undefined);

  const storedBeforeRetry = JSON.parse(await readFile(path.join(dataDir, 'assets.json'), 'utf8'))[0];
  const localPath = path.join(dataDir, 'uploads', storedBeforeRetry.localPath);
  assert.deepEqual(await readFile(localPath), contents);

  const retry = await fetch(`${baseUrl}/api/assets/${saved.id}/sync`, { method: 'POST' });
  assert.equal(retry.status, 200);
  const { item: synced } = await retry.json();
  assert.equal(synced.id, saved.id);
  assert.equal(synced.arkFileId, 'uploaded-file-1');
  assert.equal(synced.status, '已同步方舟 Files API');
  assert.equal(synced.error, undefined);

  const storedAfterRetry = JSON.parse(await readFile(path.join(dataDir, 'assets.json'), 'utf8'))[0];
  assert.equal(storedAfterRetry.localPath, storedBeforeRetry.localPath);
  assert.equal((await stat(localPath)).size, contents.length);
  assert.deepEqual(await readFile(localPath), contents);
});
