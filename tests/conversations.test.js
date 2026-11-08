import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { startServer, mockArk, until } from './helpers/server.js';
import { generationInstructions } from '../lib/generation-policy.js';

const configured = ark => ({ ARK_API_KEY: 'local-test-key', ARK_AGENT_ID: 'test-agent', ARK_ENVIRONMENT_ID: 'test-environment', ARK_BASE_URL: ark.baseUrl });
const latest = ark => [...ark.sessions.values()].at(-1);
const settled = (request, id, status = 'completed') => until(async () => { const { task } = await request(`/api/tasks/${id}`); return task.status === status && task; });

test('accepts messages and goal descriptions longer than 2000 characters', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const prompt = '创作需求'.repeat(30000);
  const objective = '持续目标'.repeat(700);
  const { task } = await request('/api/creative', { prompt, goal: { objective } });

  assert.equal(task.messages[0].text, prompt);
  assert.equal(task.goal.objective, objective);
  await until(() => latest(ark)?.submissions === 1);

  const followUp = '后续补充'.repeat(700);
  const queued = await request(`/api/tasks/${task.id}/messages`, { text: followUp });
  assert.equal(queued.status, 202);
  assert.equal(queued.task.pendingMessages[0].text, followUp);
});

for (const [name, readyChunks] of [
  ['single-line readiness comment', [': ready\n']],
  ['fragmented readiness comment', [': rea', 'dy\n']],
  ['CRLF readiness comment', [': ready\r', '\n']]
]) {
  test(`sends after ${name} without waiting for an event separator`, async t => {
    const ark = await mockArk(t, { readyDelay: 40, readyChunks });
    const { request } = await startServer(t, configured(ark));
    const { task } = await request('/api/creative', { prompt: 'Keep my message' });
    await until(() => latest(ark)?.submissions === 1, 2000);
    const session = latest(ark);
    assert.equal(session.sentBeforeReady, undefined);
    ark.finish(session);
    const done = await settled(request, task.id);
    assert.equal(done.messages[0].text, 'Keep my message');
    assert.equal(done.messages[0].delivery, 'sent');
    assert.equal(session.submissions, 1);
    assert.equal(session.streams, 1);
  });
}

test('failed Session creation retains the original message and explicit retry sends it once', async t => {
  const ark = await mockArk(t, { sessionFailures: 1 });
  const { request, dataDir } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Original message', requestId: 'session-failure-001' });
  const failed = await settled(request, task.id, 'failed');
  assert.equal(failed.sessionId, undefined);
  assert.equal(failed.messages[0].text, 'Original message');
  assert.equal(failed.messages[0].delivery, 'queued');
  const saved = JSON.parse(await readFile(`${dataDir}/tasks.json`, 'utf8'));
  assert.equal(saved[0].messages[0].text, 'Original message');
  await request(`/api/tasks/${task.id}/resume`, {});
  await until(() => latest(ark)?.submissions === 1);
  ark.finish(latest(ark));
  const done = await settled(request, task.id);
  assert.equal(done.messages.filter(item => item.role === 'user').length, 1);
  assert.equal(latest(ark).submissions, 1);
});

test('recovery distinguishes an unsent message from an uncertain delivery and resumes the original', async t => {
  const ark = await mockArk(t);
  const first = await startServer(t, configured(ark));
  const { task } = await first.request('/api/creative', { prompt: 'Unsent original' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  const exit = once(first.child, 'exit');
  first.child.kill('SIGTERM');
  await exit;
  const saved = JSON.parse(await readFile(`${first.dataDir}/tasks.json`, 'utf8'));
  saved[0].status = 'interrupted';
  saved[0].messages[0].delivery = 'queued';
  saved[0].seenEventIds = [];
  saved[0].cloudTurnOpen = false;
  session.history = [];
  session.status = 'idle';
  session.submissions = 0;
  session.messages = [];
  await writeFile(`${first.dataDir}/tasks.json`, JSON.stringify(saved));
  const second = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  await second.request(`/api/tasks/${task.id}/recover`, {});
  const recovered = await settled(second.request, task.id, 'interrupted');
  assert.equal(recovered.stopReason, 'message_not_sent');
  assert.equal(recovered.messages[0].delivery, 'queued');
  assert.equal(session.submissions, 0);
  const blocked = await second.request(`/api/tasks/${task.id}/messages`, { prompt: 'A follow-up must not skip the unsent original' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.error, /上一条消息尚未发送/);
  await second.request(`/api/tasks/${task.id}/resume`, {});
  await until(() => session.submissions === 1);
  assert.equal(session.messages[0].content[0].text.startsWith('Unsent original'), true);
  ark.finish(session);
  const done = await settled(second.request, task.id);
  assert.equal(done.messages.filter(item => item.role === 'user').length, 1);
  assert.equal(ark.sessions.size, 1);
});

test('reuses a Session for follow-ups, queues locally, deduplicates submissions and waits for SSE readiness', async t => {
  const ark = await mockArk(t, { readyDelay: 80 });
  const { request } = await startServer(t, configured(ark));
  const body = { prompt: 'First turn', requestId: 'request-first-001' };
  const { task } = await request('/api/creative', body);
  assert.equal(task.messages[0].requestId, body.requestId);
  const duplicate = await request('/api/creative', body);
  assert.equal(duplicate.task.id, task.id);
  assert.equal((await request('/api/creative', { ...body, prompt: 'Different' })).status, 409);
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  assert.equal(session.sentBeforeReady, undefined);
  assert.ok(session.message.events.at(-1).content[0].text.includes(generationInstructions));
  const queued = await request(`/api/tasks/${task.id}/messages`, { prompt: 'Second turn', requestId: 'request-second-001' });
  assert.equal(queued.task.pendingMessages.length, 1);
  const queuedMessage = queued.task.pendingMessages[0];
  assert.ok(queuedMessage.timelineOrder > task.messages[0].timelineOrder);
  assert.equal(session.submissions, 1);
  await request(`/api/tasks/${task.id}/messages`, { prompt: 'Second turn', requestId: 'request-second-001' });
  ark.finish(session, false, { text: 'First answer' });
  await until(() => session.submissions === 2);
  assert.ok(session.message.events.at(-1).content[0].text.includes(generationInstructions));
  ark.finish(session, false, { text: 'Second answer' });
  const result = await settled(request, task.id);
  assert.equal(ark.sessions.size, 1);
  assert.deepEqual(result.messages.filter(item => item.role === 'assistant').map(item => item.text), ['First answer', 'Second answer']);
  assert.equal(result.pendingMessages.length, 0);
  assert.equal(result.messages.find(item => item.requestId === 'request-second-001').timelineOrder, queuedMessage.timelineOrder);
  assert.ok(result.messages.find(item => item.text === 'First answer').timelineOrder > queuedMessage.timelineOrder);
  assert.equal(session.messages[1].content[0].text.startsWith('Second turn'), true);
});

test('pause confirms cloud interruption and resume keeps Session and pending messages', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Long task' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  await request(`/api/tasks/${task.id}/messages`, { text: 'Queued follow-up' });
  const paused = await request(`/api/tasks/${task.id}/pause`, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.task.status, 'paused');
  assert.equal(paused.task.pendingMessages[0].delivery, 'held');
  assert.equal(session.interrupts, 1);
  assert.equal(session.status, 'idle');
  await request(`/api/tasks/${task.id}/pause`, {});
  assert.equal(session.interrupts, 1);
  await request(`/api/tasks/${task.id}/resume`, {});
  await until(() => session.submissions === 2);
  assert.equal(ark.sessions.size, 1);
  assert.equal(session.messages[1].content[0].text.startsWith('Queued follow-up'), true);
  ark.finish(session);
  await settled(request, task.id);
});

test('a queued job can pause without waiting for an occupied execution slot', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, { ...configured(ark), MAX_CONCURRENT_TASKS: '1' });
  await request('/api/creative', { prompt: 'Occupy slot' });
  await until(() => latest(ark)?.submissions === 1);
  const { task } = await request('/api/creative', { prompt: 'Waiting task' });
  const start = Date.now();
  const paused = await request(`/api/tasks/${task.id}/pause`, {});
  assert.equal(paused.task.status, 'paused');
  assert.ok(Date.now() - start < 1500);
  assert.equal(ark.sessions.size, 1);
});

test('immediate steering uses current cloud turn and does not create a new Session', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Main task' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  const result = await request(`/api/tasks/${task.id}/messages`, { text: 'Use blue', delivery: 'steer' });
  assert.equal(result.status, 202);
  await until(() => session.submissions === 2);
  assert.equal(result.task.pendingMessages.length, 0);
  ark.finish(session);
  const done = await settled(request, task.id);
  assert.equal(done.messages.filter(item => item.role === 'user').length, 2);
  assert.equal(ark.sessions.size, 1);
});

test('reconnect merges paginated history and realtime events once without resending', async t => {
  const ark = await mockArk(t, { pageSize: 2 });
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Reconnect task' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  ark.emit(session, { type: 'agent.message', content: [{ type: 'text', text: 'Before disconnect' }] });
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.messages.some(item => item.text === 'Before disconnect'));
  session.stream.destroy();
  ark.emit(session, { type: 'agent.message', content: [{ type: 'text', text: 'During disconnect' }] });
  await until(() => session.streams >= 2 && session.ready);
  ark.finish(session, false, { text: 'After reconnect' });
  const done = await settled(request, task.id);
  assert.deepEqual(done.messages.filter(item => item.role === 'assistant').map(item => item.text), ['Before disconnect', 'During disconnect', 'After reconnect']);
  assert.equal(session.submissions, 1);
});

test('lost POST response is recovered from history without duplicate generation', async t => {
  const ark = await mockArk(t, { postFailure: true });
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Unknown delivery' });
  await until(() => latest(ark)?.submissions === 1 && latest(ark).streams >= 2 && latest(ark).ready);
  const session = latest(ark);
  ark.finish(session);
  const done = await settled(request, task.id);
  assert.equal(done.messages.find(item => item.role === 'user').delivery, 'sent');
  assert.equal(session.submissions, 1);
});

test('service restart recovers the original cloud Session and history without a new POST', async t => {
  const ark = await mockArk(t);
  const first = await startServer(t, configured(ark));
  const { task } = await first.request('/api/creative', { prompt: 'Restart task' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  ark.emit(session, { type: 'agent.message', content: [{ type: 'text', text: 'While server was offline' }] });
  const second = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  await until(() => session.streams >= 2 && session.ready);
  ark.finish(session, false, { text: 'Recovered result' });
  const done = await settled(second.request, task.id);
  assert.equal(done.sessionId, session.id);
  assert.deepEqual(done.messages.filter(item => item.role === 'assistant').map(item => item.text), ['While server was offline', 'Recovered result']);
  assert.equal(ark.sessions.size, 1);
  assert.equal(session.submissions, 1);
});

test('requires_action waits for explicit tool confirmation before continuing', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Confirm a tool' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  const tool = ark.emit(session, { type: 'agent.tool_use', name: 'Skill', input: { skill: 'video-producer' } });
  ark.finish(session, false, { text: 'Please approve', stopReason: 'requires_action', eventIds: [tool.id] });
  await settled(request, task.id, 'waiting');
  assert.equal((await request(`/api/tasks/${task.id}/messages`, { text: 'Skip approval' })).status, 409);
  assert.equal((await request(`/api/tasks/${task.id}/confirm`, { toolUseId: 'wrong', allow: true })).status, 400);
  const approved = await request(`/api/tasks/${task.id}/confirm`, { toolUseId: tool.id, allow: true });
  assert.equal(approved.status, 202);
  await until(() => session.streams >= 2 && session.ready);
  ark.finish(session, false, { text: 'Approved result' });
  const done = await settled(request, task.id);
  assert.equal(done.messages.at(-1).text, 'Approved result');
  assert.equal(session.confirmations[0].tool_use_id, tool.id);
  assert.equal(session.confirmations[0].result, 'allow');
  assert.equal(session.submissions, 1);
});

test('persistent goals continue on the same Session and stop on completion or budget', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Goal task' });
  await request(`/api/tasks/${task.id}/goal`, { objective: 'Finish the full video', tokenBudget: 1000 });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  ark.finish(session, false, { text: 'More work remains', usage: { input_tokens: 100, output_tokens: 50 } });
  await until(() => session.submissions === 2);
  const events = session.message.events;
  assert.equal(events.at(-1).type, 'system.message');
  assert.ok(events.at(-1).content[0].text.includes('Finish the full video'));
  assert.ok(events.at(-1).content[0].text.includes(generationInstructions));
  ark.finish(session, false, { text: 'Verified everything\n<<GOAL_COMPLETE>>', usage: { input_tokens: 200, output_tokens: 100 } });
  let done = await settled(request, task.id);
  assert.equal(done.goal.status, 'complete');
  assert.equal(done.goal.turns, 2);
  assert.equal(session.submissions, 2);
  await request(`/api/tasks/${task.id}/goal`, { objective: 'Another goal', tokenBudget: 10 });
  await until(() => session.submissions === 3);
  ark.finish(session, false, { text: 'Not done yet', usage: { input_tokens: 210, output_tokens: 110 } });
  done = await settled(request, task.id);
  assert.equal(done.goal.status, 'budget_exceeded');
  assert.equal(done.goal.tokensUsed, 20);
  assert.equal(session.submissions, 3);
});

test('recovering a completed conversation resumes its active goal on the original Session', async t => {
  const ark = await mockArk(t);
  const first = await startServer(t, configured(ark));
  const { task } = await first.request('/api/creative', { prompt: 'Recover an active goal', goal: { objective: 'Finish the campaign' } });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  ark.finish(session, false, { text: 'The campaign still needs work', usage: { input_tokens: 100, output_tokens: 50 } });
  await first.request(`/api/tasks/${task.id}/goal`, { action: 'pause' });
  await until(async () => (await first.request(`/api/tasks/${task.id}`)).task.status === 'completed');

  const records = JSON.parse(await readFile(`${first.dataDir}/tasks.json`, 'utf8'));
  const saved = records.find(item => item.id === task.id);
  saved.goal.status = 'active';
  await writeFile(`${first.dataDir}/tasks.json`, JSON.stringify(records, null, 2));
  const exited = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await exited;

  const second = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  const recovered = await second.request(`/api/tasks/${task.id}/recover`, {});
  assert.equal(recovered.status, 202);
  await until(() => session.streams >= 2 && session.ready);
  await until(() => session.submissions === 2);
  assert.equal(ark.sessions.size, 1);
  assert.equal(session.messages[1].content[0].text.startsWith('继续推进已设定的持续目标'), true);
  assert.ok(session.message.events.at(-1).content[0].text.includes(generationInstructions));
  assert.equal(session.submissions, 2);
  ark.finish(session, false, { text: 'Campaign complete\n<<GOAL_COMPLETE>>', usage: { input_tokens: 200, output_tokens: 100 } });
  const done = await settled(second.request, task.id);
  assert.equal(done.goal.status, 'complete');
  assert.equal(done.sessionId, session.id);
});

test('SSE serves current state, message queue can be removed, and metadata persists', async t => {
  const ark = await mockArk(t);
  const { request, baseUrl } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Manage me' });
  await until(() => latest(ark)?.submissions === 1);
  const queued = await request(`/api/tasks/${task.id}/messages`, { text: 'Remove me' });
  const id = queued.task.pendingMessages[0].id;
  let response = await fetch(`${baseUrl}/api/tasks/${task.id}/messages/${id}`, { method: 'DELETE' });
  assert.equal((await response.json()).task.pendingMessages.length, 0);
  const controller = new AbortController();
  response = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const frame = new TextDecoder().decode((await reader.read()).value);
  assert.ok(frame.includes('event: task'));
  assert.ok(frame.includes(task.id));
  controller.abort(); await reader.cancel().catch(() => {});
  const metadata = await request(`/api/tasks/${task.id}/metadata`, { title: 'Renamed', pinned: true, archived: true });
  assert.equal(metadata.task.title, 'Renamed');
  assert.equal(metadata.task.pinned, true);
  assert.equal((await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: 'DELETE' })).status, 409);
  await request(`/api/tasks/${task.id}/pause`, {});
  assert.equal((await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: 'DELETE' })).status, 200);
});

test('creating a goal is atomic, plan mode disables cloud tools, and Agent mode restores the same Session', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Make a plan', mode: 'plan', goal: { objective: 'Plan the campaign', tokenBudget: 500 } });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  assert.equal(session.input.agent.type, 'agent_with_overrides');
  assert.equal(session.input.agent.tools.every(tool => tool.default_config.enabled === false), true);
  assert.equal(session.message.events.at(-1).type, 'system.message');
  assert.ok(session.message.events.at(-1).content[0].text.includes('Plan the campaign'));
  ark.finish(session, false, { text: 'Plan verified\n<<GOAL_COMPLETE>>', usage: { input_tokens: 100, output_tokens: 50 } });
  const completed = await settled(request, task.id);
  assert.equal(completed.goal.status, 'complete');
  await request(`/api/tasks/${task.id}/settings`, { mode: 'agent' });
  await request(`/api/tasks/${task.id}/messages`, { text: 'Execute the plan', options: { aspectRatio: '9:16', style: '电影质感' } });
  await until(() => session.submissions === 2);
  assert.equal(session.upgrades.length, 1);
  assert.equal(session.upgrades[0].agent.type, 'agent_with_upgrades');
  assert.equal(session.upgrades[0].agent.tools[1].configs[1].name, 'video_generate');
  assert.equal(session.upgrades[0].agent.tools[1].configs[1].enabled, false);
  assert.ok(session.upgrades[0].agent.tools.some(tool => tool.name === 'generate_image_without_watermark'));
  assert.ok(session.upgrades[0].agent.tools.some(tool => tool.name === 'generate_video_without_watermark'));
  assert.ok(session.messages[1].content[0].text.includes('9:16'));
  assert.ok(session.messages[1].content[0].text.includes('电影质感'));
  ark.finish(session);
  await settled(request, task.id);
  assert.equal(ark.sessions.size, 1);
});

test('pausing during a delayed initial send interrupts after delivery and cannot start a late cloud turn', async t => {
  const ark = await mockArk(t, { messageDelay: 200 });
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Delayed initial send' });
  await until(async () => (await request(`/api/tasks/${task.id}`)).task.messages[0].delivery === 'sending');
  const paused = await request(`/api/tasks/${task.id}/pause`, {});
  assert.equal(paused.task.status, 'paused');
  const session = latest(ark);
  assert.equal(session.submissions, 1);
  assert.equal(session.interrupts, 1);
  assert.equal(session.status, 'idle');
  assert.equal(session.history.at(-2).type, 'user.interrupt');
});

test('pausing during Session creation saves its ID and prevents the original message from being sent', async t => {
  const ark = await mockArk(t, { sessionDelay: 150 });
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Delayed creation' });
  await until(() => ark.sessions.size === 1);
  const paused = await request(`/api/tasks/${task.id}/pause`, {});
  assert.equal(paused.task.status, 'paused');
  assert.equal(paused.task.sessionId, latest(ark).id);
  assert.equal(latest(ark).submissions, 0);
  await request(`/api/tasks/${task.id}/resume`, {});
  await until(() => latest(ark).submissions === 1);
  ark.finish(latest(ark)); await settled(request, task.id);
  assert.equal(ark.sessions.size, 1);
});

test('a restarted pending message shares timeline delivery and is sent only once across two restarts', async t => {
  const ark = await mockArk(t);
  const first = await startServer(t, configured(ark));
  const { task } = await first.request('/api/creative', { prompt: 'Restart with queue' });
  await until(() => latest(ark)?.submissions === 1);
  await first.request(`/api/tasks/${task.id}/messages`, { text: 'Persisted queued message' });
  let exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const session = latest(ark);
  const second = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  await until(() => session.streams >= 2 && session.ready);
  ark.finish(session, false, { text: 'Recovered first turn' });
  await until(() => session.submissions === 2);
  ark.finish(session, false, { text: 'Recovered queue result' });
  const done = await settled(second.request, task.id);
  assert.equal(done.messages.find(item => item.text === 'Persisted queued message').delivery, 'sent');
  assert.equal(done.pendingMessages.length, 0);
  exited = once(second.child, 'exit'); second.child.kill('SIGKILL'); await exited;
  const third = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  assert.equal((await third.request(`/api/tasks/${task.id}`)).task.status, 'completed');
  assert.equal(session.submissions, 2);
});

test('resuming a missing stop reason can send a new continuation after recovery without replaying the original', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Check stop reason' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle' });
  await settled(request, task.id, 'interrupted');
  const resumed = await request(`/api/tasks/${task.id}/resume`, {});
  assert.equal(resumed.status, 202);
  await until(() => session.submissions === 2);
  assert.ok(session.messages[1].content[0].text.includes('继续'));
  ark.finish(session); await settled(request, task.id);
});

test('a connected interrupted turn accepts an explicit follow-up on the original Session', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Create a 15 second video' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle' });
  const interrupted = await settled(request, task.id, 'interrupted');
  assert.equal(interrupted.connection, 'connected');
  const body = { prompt: 'Extend the video to one minute', requestId: 'connected-followup-001' };
  assert.equal((await request(`/api/tasks/${task.id}/messages`, body)).status, 202);
  await until(() => session.submissions === 2);
  assert.equal((await request(`/api/tasks/${task.id}/messages`, body)).status, 202);
  ark.finish(session);
  const done = await settled(request, task.id);
  assert.equal(session.submissions, 2);
  assert.equal(ark.sessions.size, 1);
  assert.equal(done.messages.filter(item => item.text === body.prompt).length, 1);
});

test('unknown delivery requires explicit resolution before accepting a follow-up', async t => {
  const ark = await mockArk(t);
  const first = await startServer(t, configured(ark));
  const { task } = await first.request('/api/creative', { prompt: 'Uncertain original message' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  const exited = once(first.child, 'exit');
  first.child.kill('SIGTERM');
  await exited;
  const saved = JSON.parse(await readFile(`${first.dataDir}/tasks.json`, 'utf8'));
  Object.assign(saved[0], { status: 'interrupted', connection: 'disconnected', cloudTurnOpen: false });
  saved[0].messages[0].delivery = 'unknown';
  session.status = 'idle';
  session.history = [];
  await writeFile(`${first.dataDir}/tasks.json`, JSON.stringify(saved));
  const second = await startServer(t, { ...configured(ark), VISIONARY_DATA_DIR: first.dataDir });
  await second.request(`/api/tasks/${task.id}/recover`, {});
  const recovered = await settled(second.request, task.id, 'interrupted');
  assert.equal(recovered.stopReason, 'delivery_unknown');
  const blocked = await second.request(`/api/tasks/${task.id}/messages`, { prompt: 'Do not hide the uncertain original' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.error, /发送结果未确认/);
  assert.equal(session.submissions, 1);
});

test('live running events cannot unlock sending before recovery has synchronized approval history', async t => {
  const ark = await mockArk(t, { historyDelay: 400 });
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Wait for explicit approval' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  session.status = 'idle';
  ark.emit(session, { type: 'session.status_idle' });
  await settled(request, task.id, 'interrupted');
  const tool = ark.emit(session, { type: 'agent.tool_use', name: 'Skill', input: { skill: 'video-producer' } });
  ark.finish(session, false, { stopReason: 'requires_action', eventIds: [tool.id] });
  assert.equal((await request(`/api/tasks/${task.id}/recover`, {})).status, 202);
  const recovering = await until(async () => {
    const { task: value } = await request(`/api/tasks/${task.id}`);
    return value.recoveryPending && value.connection === 'connected' && value;
  });
  assert.equal(recovering.recoveryPending, true);
  const blocked = await request(`/api/tasks/${task.id}/messages`, { prompt: 'Do not bypass approval' });
  assert.equal(blocked.status, 409);
  await settled(request, task.id, 'waiting');
  assert.equal((await request(`/api/tasks/${task.id}`)).task.recoveryPending, false);
  assert.equal(session.confirmations.length, 0);
  assert.equal(session.submissions, 1);
});

test('a goal update during an unrelated turn cannot inherit an older completion marker', async t => {
  const ark = await mockArk(t);
  const { request } = await startServer(t, configured(ark));
  const { task } = await request('/api/creative', { prompt: 'Old task' });
  await until(() => latest(ark)?.submissions === 1);
  const session = latest(ark);
  await request(`/api/tasks/${task.id}/goal`, { objective: 'A new target' });
  ark.finish(session, false, { text: 'Old task complete\n<<GOAL_COMPLETE>>' });
  await until(() => session.submissions === 2);
  assert.equal((await request(`/api/tasks/${task.id}`)).task.goal.status, 'active');
  ark.finish(session, false, { text: 'New target complete\n<<GOAL_COMPLETE>>' });
  assert.equal((await settled(request, task.id)).goal.status, 'complete');
});
