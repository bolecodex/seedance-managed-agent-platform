import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTaskQueue } from '../lib/task-queue.js';

test('accepts more jobs than execution slots and drains them in submission order', async () => {
  const queue = createTaskQueue(2);
  const started = [];
  const release = [];
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 6 }, (_, index) => queue.enqueue(async () => {
    started.push(index);
    peak = Math.max(peak, ++running);
    await new Promise(resolve => { release[index] = resolve; });
    running--;
    return index;
  }));
  await nextTurn();
  assert.deepEqual(started, [0, 1]);
  for (let index = 0; index < jobs.length; index++) {
    assert.equal(typeof release[index], 'function');
    release[index]();
    await nextTurn();
  }
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test('releases slots after asynchronous rejection and synchronous exceptions', async () => {
  const queue = createTaskQueue(1);
  const jobs = [
    queue.enqueue(async () => { throw new Error('async failure'); }),
    queue.enqueue(() => { throw new Error('sync failure'); }),
    queue.enqueue(() => 'next job completed')
  ];
  const results = await Promise.allSettled(jobs);
  assert.equal(results[0].reason.message, 'async failure');
  assert.equal(results[1].reason.message, 'sync failure');
  assert.deepEqual(results[2], { status: 'fulfilled', value: 'next job completed' });
});

test('rejects invalid execution limits', () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, '3']) assert.throws(() => createTaskQueue(limit), /正整数/);
});

test('changing concurrency drains queued jobs without cancelling running work', async () => {
  const queue = createTaskQueue(1);
  const started = [];
  const release = [];
  const jobs = Array.from({ length: 4 }, (_, i) => queue.enqueue(async () => { started.push(i); await new Promise(resolve => { release[i] = resolve; }); }));
  await nextTurn();
  queue.setConcurrency(2);
  await nextTurn();
  assert.deepEqual(started, [0, 1]);
  queue.setConcurrency(1);
  release[0](); await nextTurn();
  assert.deepEqual(started, [0, 1]);
  release[1](); await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);
  release[2](); await nextTurn(); release[3]();
  await Promise.all(jobs);
  assert.throws(() => queue.setConcurrency(0), /正整数/);
});
