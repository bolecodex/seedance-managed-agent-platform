import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareOutputFiles, rememberOutputReferences } from '../lib/output-files.js';

const file = (id, filename, mime_type = 'video/mp4') => ({ id, filename, mime_type, download_url: `https://files.test/${id}` });
const videoJob = (id, filename, prompt) => ({ id, outputPath: filename, prompt, file: file(id, filename) });

test('historical video metadata comes from its own tool call and path aliases do not duplicate the video', () => {
  const task = {
    assetVideoJobs: {
      first: videoJob('cgt-first', '/mnt/session/outputs/first.mp4'),
      second: videoJob('cgt-second', '/mnt/session/outputs/second.mp4')
    },
    executionSteps: [{ id: 'second', input: { prompt: 'Second video\nFull prompt.' } }, { id: 'first', input: { prompt: 'First video\nFull prompt.' } }]
  };
  const files = prepareOutputFiles(task, [file('registered-first', 'first.mp4'), file('registered-second', 'second.mp4')]);
  assert.deepEqual(files.map(item => [item.cgt_id, item.prompt]), [['cgt-first', 'First video\nFull prompt.'], ['cgt-second', 'Second video\nFull prompt.']]);
  assert.equal(task.assetVideoJobs.first.prompt, 'First video\nFull prompt.');
  assert.deepEqual(prepareOutputFiles(task, files), files);
});

test('saved prompts take precedence over later call inputs and distinct clips sharing a basename are retained', () => {
  const task = {
    assetVideoJobs: {
      first: videoJob('cgt-first', '/mnt/session/outputs/a/clip.mp4', 'Actual first prompt'),
      second: videoJob('cgt-second', '/mnt/session/outputs/b/clip.mp4', 'Actual second prompt')
    }, executionSteps: [{ id: 'first', input: { prompt: 'Changed input' } }]
  };
  const files = prepareOutputFiles(task, [file('ambiguous', 'clip.mp4'), file('registered-first', '/mnt/session/outputs/a/clip.mp4')]);
  assert.deepEqual(files.map(item => item.id), ['cgt-first', 'cgt-second', 'ambiguous']);
  assert.equal(files[0].prompt, 'Actual first prompt');
});

test('output collection excludes reference IDs, names, upload paths and internal staging images', () => {
  const assets = [{ id: 'reference-12345', name: '场景.png', localPath: 'local.png', arkFileId: 'input-file' }];
  const task = { executionSteps: [{ id: 'inspect', output: [{ type: 'text', text: 'Files:\n/mnt/session/outputs/.staging/converted.jpg\n' }] }] };
  const final = file('final', '/mnt/session/outputs/final.mp4');
  const image = file('generated-image', '/mnt/session/outputs/keyframe.jpg', 'image/jpeg');
  const files = prepareOutputFiles(task, [
    file('input-file', 'renamed.png', 'image/png'),
    file('renamed-reference', '场景.png', 'image/png'),
    file('local-reference', 'local.png', 'image/png'),
    file('prefixed', 'referenc-场景.png', 'image/png'),
    file('uploaded', '/mnt/session/uploads/unlisted.png', 'image/png'),
    file('staged', '/mnt/session/outputs/.staging/another.jpg', 'image/jpeg'),
    file('staged-alias', 'converted.jpg', 'image/jpeg'), final, image
  ], assets);
  assert.deepEqual(files, [final, image]);
});

test('reference snapshots survive a later turn, deletion and JSON persistence', () => {
  const task = {};
  rememberOutputReferences(task, [{ id: 'first', name: 'first.jpg', arkFileId: 'first-file', localPath: 'first-local.jpg' }]);
  rememberOutputReferences(task, [{ id: 'second', name: 'second.jpg', arkFileId: 'second-file' }]);
  rememberOutputReferences(task, [{ id: 'first', name: 'first.jpg' }]);
  const restored = JSON.parse(JSON.stringify(task));
  const final = file('final', 'final.mp4');
  assert.deepEqual(prepareOutputFiles(restored, [file('first-file', 'renamed.jpg'), file('alias', 'first-local.jpg'), file('second-file', 'second.jpg'), final]), [final]);
});

test('verified generated outputs survive name collisions with inputs', () => {
  const task = { imageGenerationJobs: { first: { file: file('generated', '/mnt/session/outputs/场景.png', 'image/png') } } };
  const files = prepareOutputFiles(task, [file('reference', '场景.png', 'image/png')], [{ id: 'ref', name: '场景.png', arkFileId: 'reference' }]);
  assert.deepEqual(files, [task.imageGenerationJobs.first.file]);
});

test('unattributed historical videos keep missing metadata instead of reusing the user request', () => {
  const original = file('legacy-file', 'old.mp4');
  const files = prepareOutputFiles({ prompt: 'User request, not a generation prompt' }, [original]);
  assert.deepEqual(files, [original]);
  assert.equal(files[0].prompt, undefined);
  assert.equal(files[0].cgt_id, undefined);
});
