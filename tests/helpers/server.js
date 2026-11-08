import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

export async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await wait(30);
  }
  throw new Error('Timed out waiting for expected task state');
}

export async function startServer(t, overrides = {}) {
  const providedDataDir = overrides.VISIONARY_DATA_DIR;
  const dataDir = providedDataDir || await mkdtemp(path.join(tmpdir(), 'visionary-async-test-'));
  const probe = http.createServer();
  const baseUrl = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ARK_')));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...cleanEnv, VISIONARY_ENV_FILE: path.join(dataDir, 'absent.env'), VISIONARY_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: new URL(baseUrl).port, MAX_CONCURRENT_TASKS: '2', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    if (!providedDataDir) await rm(dataDir, { recursive: true, force: true });
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    try { return (await fetch(`${baseUrl}/api/config`)).ok; } catch { return false; }
  });
  const request = async (endpoint, body) => {
    const response = await fetch(`${baseUrl}${endpoint}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  return { baseUrl, dataDir, request, child };
}

export async function mockArk(t, { uploadFailures = 0, readyDelay = 0, readyChunks = [': ready\n\n'], sessionFailures = 0, pageSize = 100, postFailure = false, messageDelay = 0, sessionDelay = 0, historyDelay = 0, assetStatus = 'Active', customResultFailure = false } = {}) {
  const sessions = new Map();
  const assets = new Map();
  const assetRequests = [];
  const videoRequests = [];
  let sequence = 0;
  let failedUploads = 0;
  const emit = (session, event) => {
    const full = { id: `sevt-mock-${++sequence}`, processed_at: new Date().toISOString(), ...event };
    if (!['event_start', 'event_delta'].includes(full.type)) session.history.push(full);
    if (session.stream && !session.stream.destroyed) session.stream.write(`data: ${JSON.stringify(full)}\n\n`);
    return full;
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://test');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length && request.headers['content-type']?.includes('application/json') ? JSON.parse(Buffer.concat(chunks)) : {};
    const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const baselineAgent = { id: 'test-agent', version: 1, tools: [{ type: 'agent_toolset_20260916', default_config: { enabled: true }, configs: [{ name: 'web_search', enabled: false }] }, { type: 'agent_toolset_multimodal_20260825', default_config: { enabled: true }, configs: [{ name: 'image_generate', enabled: true }, { name: 'video_generate', enabled: true }, { name: 'visual_search', enabled: true }, { name: 'general_search', enabled: true }, { name: 'compose_video', enabled: true }] }], mcp_servers: [] };
    if (url.pathname === '/agents/test-agent' && request.method === 'GET') return json(baselineAgent);
    if (url.pathname === '/sessions' && request.method === 'POST') {
      if (sessionFailures > 0) { sessionFailures--; return json({ error: { message: 'test session creation failed' } }, 503); }
      const session = { id: `session-${++sequence}`, title: body.title, input: body, agent: typeof body.agent === 'object' ? { ...baselineAgent, ...body.agent } : baselineAgent, status: 'idle', submissions: 0, interrupts: 0, confirmations: [], customResults: [], history: [], messages: [], streams: 0, upgrades: [] };
      sessions.set(session.id, session);
      if (sessionDelay) await wait(sessionDelay);
      return json({ id: session.id });
    }
    const match = url.pathname.match(/^\/sessions\/([^/]+)(.*)$/);
    if (match) {
      const session = sessions.get(match[1]);
      if (!session) return json({ error: { message: 'session not found' } }, 404);
      if (match[2] === '/events/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders(); session.stream = response; session.streams++; session.ready = false;
        setTimeout(async () => {
          for (let index = 0; index < readyChunks.length && !response.destroyed; index++) {
            if (index === readyChunks.length - 1) session.ready = true;
            response.write(readyChunks[index]);
            if (index < readyChunks.length - 1) await wait(10);
          }
        }, readyDelay);
        return;
      }
      if (match[2] === '/events' && request.method === 'GET') {
        if (historyDelay) await wait(historyDelay);
        const offset = Number(url.searchParams.get('page') || 0);
        return json({ data: session.history.slice(offset, offset + pageSize), ...(offset + pageSize < session.history.length ? { next_page: String(offset + pageSize) } : {}) });
      }
      if (match[2] === '/events' && request.method === 'POST') {
        if (messageDelay && body.events?.some(event => event.type === 'user.message')) await wait(messageDelay);
        for (const event of body.events || []) {
          if (event.type === 'user.message') {
            if (!session.ready) session.sentBeforeReady = true;
            session.submissions++; session.message = body; session.messages.push(event);
            emit(session, event); session.status = 'running'; emit(session, { type: 'session.status_running' });
          } else if (event.type === 'user.interrupt') {
            session.interrupts++; session.status = 'idle'; emit(session, event);
            emit(session, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
          } else if (event.type === 'user.tool_confirmation') {
            session.confirmations.push(event); emit(session, event);
            session.status = 'running'; emit(session, { type: 'session.status_running' });
          } else if (event.type === 'user.custom_tool_result') {
            if (!session.ready) session.sentBeforeReady = true;
            session.customResults.push(event); emit(session, event);
            session.status = 'running'; emit(session, { type: 'session.status_running' });
          } else emit(session, event);
        }
        if (postFailure || customResultFailure && body.events?.some(event => event.type === 'user.custom_tool_result')) return response.destroy();
        return json({});
      }
      if (match[2] === '/upgrades' && request.method === 'POST') {
        session.upgrades.push(body);
        session.agent = { ...session.agent, ...body.agent };
        session.status = 'idle';
        return json({ id: session.id, status: 'idle' });
      }
      return json({ id: session.id, status: session.status, agent: session.agent });
    }
    if (url.pathname === '/files' && request.method === 'POST') {
      if (failedUploads < uploadFailures) { failedUploads++; return json({ error: { message: 'temporary upload failure' } }, 503); }
      return json({ id: `uploaded-file-${++sequence}` });
    }
    if (url.pathname.startsWith('/files/')) return json({ id: url.pathname.split('/').at(-1), status: 'active', download_url: `https://files.test/${url.pathname.split('/').at(-1)}` });
    if (url.pathname === '/contents/generations/tasks' && request.method === 'POST') { videoRequests.push(body); return json({ id: `video-test-${videoRequests.length}`, status: 'queued' }); }
    if (url.pathname.startsWith('/contents/generations/tasks/')) return json({ id: url.pathname.split('/').at(-1), status: 'succeeded', content: { video_url: 'https://files.test/generated.mp4' } });
    if (url.pathname === '/files') {
      const id = url.searchParams.get('scope_id');
      return json({ data: [{ id: `file-${id}`, filename: `${id}.mp4`, mime_type: 'video/mp4', download_url: `https://files.test/${id}.mp4` }] });
    }
    const action = url.searchParams.get('Action');
    if (action) {
      assetRequests.push({ action, body });
      if (['GetAssetGroup', 'CreateAssetGroup'].includes(action)) return json({ Result: { Id: body.Id || 'group-test', GroupType: 'AIGC', ProjectName: body.ProjectName, Name: body.Name || 'Test characters' } });
      if (action === 'CreateAsset') {
        const item = { ...body, Id: `asset-test-${assets.size + 1}`, Status: assetStatus };
        assets.set(item.Id, item); return json({ Result: { Id: item.Id } });
      }
      if (action === 'GetAsset') return json({ Result: assets.get(body.Id) });
    }
    return json({ error: { message: 'not found' } }, 404);
  });
  const baseUrl = await listen(server);
  t.after(async () => {
    for (const session of sessions.values()) session.stream?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const finish = (session, failed = false, { text = `Result for ${session.title}`, stopReason = 'end_turn', eventIds = [], usage } = {}) => {
    if (failed) {
      emit(session, { type: 'session.error', error: { message: 'test generation failed' } });
      session.stream?.end();
    } else {
      session.status = 'idle';
      emit(session, { type: 'agent.message', content: [{ type: 'text', text }] });
      if (usage) emit(session, { type: 'session.usage', usage });
      emit(session, { type: 'session.status_idle', stop_reason: { type: stopReason, ...(eventIds.length ? { event_ids: eventIds } : {}) } });
    }
  };
  return { baseUrl, sessions, assets, assetRequests, videoRequests, finish, emit };
}
