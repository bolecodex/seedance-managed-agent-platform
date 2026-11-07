import assert from 'node:assert/strict';
import test from 'node:test';
import { createArkClient } from '../lib/ark.js';

const envNames = ['ARK_API_KEY', 'ARK_BASE_URL', 'ARK_AGENT_ID', 'ARK_ENVIRONMENT_ID'];

function configure(t, sessionStatus) {
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  Object.assign(process.env, {
    ARK_API_KEY: 'test-key',
    ARK_BASE_URL: 'https://ark.test/api/v3',
    ARK_AGENT_ID: 'test-agent',
    ARK_ENVIRONMENT_ID: 'test-environment'
  });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push(`${options.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/v3/sessions' && options.method === 'POST') return Response.json({ id: 'test-session' });
    if (url.pathname === '/api/v3/sessions/test-session/events/stream') {
      return new Response('data: {"type":"session.status_running"}\n\ndata: {"type":"session.error","error":{"message":"terminated"}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    if (url.pathname === '/api/v3/sessions/test-session/events' && options.method === 'POST') return Response.json({});
    if (url.pathname === '/api/v3/sessions/test-session') return Response.json({ id: 'test-session', status: sessionStatus });
    if (url.pathname === '/api/v3/files') {
      return Response.json({ data: [{ id: 'test-video', filename: 'episode.mp4', mime_type: 'video/mp4', download_url: 'https://files.test/episode.mp4' }] });
    }
    throw new Error(`Unexpected Ark request: ${options.method || 'GET'} ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
  });
  return { calls, ark: createArkClient({ readStore: (_name, fallback) => fallback, saveStore() {} }) };
}

const task = () => ({
  id: 'test-task', prompt: 'Generate a short film', sessionId: 'test-session',
  options: { aspectRatio: '16:9', style: '电影质感', optimize: true, versions: false },
  result: '', events: []
});

test('recovers registered video files when the terminated stream belongs to an idle session', async t => {
  const { ark, calls } = configure(t, 'idle');
  const updates = [];

  await ark.runTask(task(), [], patch => updates.push(patch));

  assert.equal(updates.at(-1).status, 'completed');
  assert.equal(updates.at(-1).files[0].filename, 'episode.mp4');
  assert.equal(calls.filter(call => call === 'GET /api/v3/files').length, 2);
});

test('does not recover video files while the terminated stream session is still running', async t => {
  const { ark, calls } = configure(t, 'running');

  await assert.rejects(ark.runTask(task(), [], () => {}), /terminated/);

  assert.equal(calls.some(call => call === 'GET /api/v3/files'), false);
});
