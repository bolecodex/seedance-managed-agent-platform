import path from 'node:path';

const basename = value => path.posix.basename(String(value || '').replace(/\\/g, '/'));

export function rememberOutputReferences(task, assets) {
  const references = new Map((task.outputReferences || []).map(item => [item.id, item]));
  for (const item of assets) {
    const snapshot = { id: item.id, name: item.name, localPath: item.localPath, arkFileId: item.arkFileId, sourceFileId: item.sourceFileId };
    references.set(item.id, { ...references.get(item.id), ...Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined)) });
  }
  if (references.size) task.outputReferences = [...references.values()];
}

export function prepareOutputFiles(task, files, assets = []) {
  rememberOutputReferences(task, assets);
  const steps = new Map((task.executionSteps || []).map(step => [step.id, step]));
  for (const [callId, job] of Object.entries(task.assetVideoJobs || {})) {
    const prompt = steps.get(callId)?.input?.prompt;
    if (!job.prompt && typeof prompt === 'string') job.prompt = prompt;
    if (job.file) {
      job.file = { ...job.file, cgt_id: job.id, ...(job.prompt ? { prompt: job.prompt } : {}) };
    }
  }
  const generated = [...new Map([...Object.values(task.assetVideoJobs || {}), ...Object.values(task.imageGenerationJobs || {})].filter(job => job.file).map(job => [job.file.id, job.file])).values()];
  const referenceIds = new Set();
  const referenceNames = new Set();
  for (const item of task.outputReferences || []) {
    for (const id of [item.arkFileId, item.sourceFileId]) if (id) referenceIds.add(id);
    for (const name of [item.name, item.localPath, item.name && `${item.id.slice(0, 8)}-${item.name.replace(/[\\/\x00-\x1f]/g, '_')}`]) if (name) referenceNames.add(basename(name));
  }
  // Older agents left converted input images in outputs/.staging. Files API
  // strips their directories, so retain the known staging filenames as well.
  for (const step of steps.values()) {
    for (const block of Array.isArray(step.output) ? step.output : []) {
      for (const match of (block.text || '').matchAll(/\/mnt\/session\/outputs\/\.staging\/[^\s"'<>]+/g)) referenceNames.add(basename(match[0]));
    }
  }
  const registered = (files || []).filter(file => {
    if (!file.download_url || referenceIds.has(file.id)) return false;
    // Generated IDs and URLs identify real outputs even when an input has the same name.
    if (generated.some(output => output.id === file.id || output.download_url === file.download_url)) return true;
    return !referenceNames.has(basename(file.filename)) && !file.filename?.includes('/.staging/') && (!file.filename?.startsWith('/mnt/session/') || file.filename.startsWith('/mnt/session/outputs/'));
  });
  return [...generated, ...registered.filter(file => {
    if (generated.some(output => output.id === file.id || output.download_url === file.download_url || output.filename === file.filename)) return false;
    // Files API can register an outputs path under its bare filename.
    return file.filename !== basename(file.filename) || generated.filter(output => basename(output.filename) === file.filename).length !== 1;
  })];
}
