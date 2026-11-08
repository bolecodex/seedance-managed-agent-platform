import assert from 'node:assert/strict';
import test from 'node:test';
import { createArkClient } from '../lib/ark.js';
import { generationInstructions } from '../lib/generation-policy.js';

function configure(t, fetch) {
  const env = {
    ARK_API_KEY: 'test-key', ARK_BASE_URL: 'https://ark.test/api/v3',
    ARK_AGENT_ID: '', ARK_ENVIRONMENT_ID: 'test-environment',
    ARK_AGENT_MODEL: 'test-agent-model', ARK_IMAGE_MODEL: 'test-image-model', ARK_VIDEO_MODEL: 'test-video-model'
  };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  t.mock.method(globalThis, 'fetch', fetch);
  return createArkClient({ readStore: (_name, fallback) => fallback, saveStore() {} });
}

test('image and video APIs disable watermarks even when callers omit or enable the flag', async t => {
  const requests = [];
  const ark = configure(t, async (url, options) => {
    assert.ok(['https://ark.test/api/v3/contents/generations/tasks', 'https://ark.test/api/v3/images/generations'].includes(url));
    assert.equal(options.method, 'POST');
    requests.push(JSON.parse(options.body));
    return Response.json({ id: 'test-video', status: 'queued' });
  });
  for (const create of [ark.createVideo, ark.createImage]) {
    for (const settings of [{}, { watermark: true }, { watermark: false }]) {
      const body = { model: 'test-model', prompt: 'A quiet sea', ...settings };
      const before = structuredClone(body);
      await create(body);
      assert.deepEqual(requests.at(-1), { ...body, watermark: false });
      assert.deepEqual(body, before);
    }
  }
  assert.equal(requests.length, 6);
});

test('automatically created agents receive the image and video watermark policy', async t => {
  let agent;
  const ark = configure(t, async (url, options) => {
    if (url === 'https://ark.test/api/v3/agents' && options.method === 'POST') {
      agent = JSON.parse(options.body);
      return Response.json({ id: 'created-agent' });
    }
    assert.equal(url, 'https://ark.test/api/v3/sessions');
    // Stop before any message or paid generation can be submitted.
    return Response.json({ error: { message: 'test session creation stopped' } }, { status: 400 });
  });
  await assert.rejects(ark.runTask({ prompt: 'Create an image and video', options: {} }, [], () => {}), /test session creation stopped/);
  assert.ok(agent.system.includes(generationInstructions));
  assert.match(agent.system, /GenImage\/image_generate/);
  assert.match(agent.system, /GenVideo\/video_generate/);
  assert.match(agent.system, /watermark=false/);
});
