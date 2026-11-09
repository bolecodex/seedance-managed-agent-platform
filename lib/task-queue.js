export function createTaskQueue(concurrency = 3) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('任务并发数必须是正整数');
  const pending = [];
  let running = 0;
  function drain() {
    while (running < concurrency && pending.length) {
      const entry = pending.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.resolve(); continue; }
      running++;
      Promise.resolve().then(entry.execute).then(entry.resolve, entry.reject).finally(() => {
        running--;
        drain();
      });
    }
  }
  return {
    setConcurrency(value) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('任务并发数必须是正整数');
      concurrency = value;
      drain();
    },
    enqueue(execute, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return resolve();
        const entry = { execute, resolve, reject, signal };
        entry.abort = () => {
          const index = pending.indexOf(entry);
          if (index >= 0) { pending.splice(index, 1); resolve(); }
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        pending.push(entry);
        drain();
      });
    }
  };
}
