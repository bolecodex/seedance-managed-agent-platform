import assert from 'node:assert/strict';
import test from 'node:test';
import { mentionContext, mentionToken, mentionCandidates, resolveMentions, removeMentions } from '../public/mentions.js';

const assets = [
  { id: 'image-id-111', name: '平面图 1.jpg', type: 'image/jpeg', collection: 'reference' },
  { id: 'video-id-222', name: '中古孟菲斯风格参考.mp4', type: 'video/mp4', collection: 'reference' },
  { id: 'audio-id-333', name: 'Music.wav', type: 'audio/wav', collection: 'reference' },
  { id: 'document-444', name: 'Brief.pdf', type: 'application/pdf', collection: 'reference' }
];

test('mention searches work at the caret in Chinese prose and avoid email, URL, selection and completed tokens', () => {
  const text = '参考@平面图 1，然后设计房间';
  const caret = text.indexOf('，');
  assert.deepEqual(mentionContext(text, caret), { start: 2, end: caret, query: '平面图 1' });
  assert.equal(mentionContext(text, 2, 5), null);
  for (const value of ['mail@example.com', 'https://host/@room', '参考 @「平面图 1.jpg」 ', '@\n新一行', '@@', 'foo＠bar']) {
    assert.equal(mentionContext(value, value.length), null, value);
  }
  assert.deepEqual(mentionContext('参考，＠视频', 6), { start: 3, end: 6, query: '视频' });
});

test('search ranks attached references first, matches names and media types and normalizes case and width', () => {
  const selected = new Set([assets[1].id, assets[0].id]);
  assert.deepEqual(mentionCandidates(assets, selected, '').slice(0, 2), [assets[1], assets[0]]);
  assert.deepEqual(mentionCandidates(assets, selected, '平 面'), [assets[0]]);
  assert.deepEqual(mentionCandidates(assets, selected, '视频'), [assets[1]]);
  assert.deepEqual(mentionCandidates(assets, selected, '音频'), [assets[2]]);
  assert.deepEqual(mentionCandidates(assets, selected, '文档'), [assets[3]]);
  assert.deepEqual(mentionCandidates(assets, selected, 'ＭＵＳＩＣ'), [assets[2]]);
  assert.deepEqual(mentionCandidates(assets, selected, '不存在'), []);
});

test('mentions preserve file names, distinguish duplicate names and resolve each asset once', () => {
  const sameName = [{ ...assets[0], id: 'same-id-111111' }, { ...assets[0], id: 'same-id-122222' }];
  const first = mentionToken(sameName[0], sameName);
  const second = mentionToken(sameName[1], sameName);
  assert.notEqual(first, second);
  const text = `参考 ${first} 和 ${second}，再参考 ${first}`;
  assert.deepEqual(resolveMentions(text, sameName), { ids: sameName.map(item => item.id), missing: [] });
  assert.deepEqual(resolveMentions(mentionToken(assets[0]), assets), { ids: [assets[0].id], missing: [] });
  assert.deepEqual(resolveMentions('@「已删除.jpg」', assets), { ids: [], missing: ['@「已删除.jpg」'] });
  assert.deepEqual(resolveMentions(mentionToken(assets[0]), sameName).ids, [], 'ambiguous names are never guessed');
  assert.deepEqual(resolveMentions(first, [sameName[1]]).ids, [], 'a deleted duplicate never binds to another file');
});

test('quoted and special file names round trip and removing references leaves surrounding text intact', () => {
  const special = { ...assets[0], name: '<img onerror=alert(1)> 空格「引号」\\图片.jpg' };
  const token = mentionToken(special);
  assert.deepEqual(resolveMentions(token, [special]), { ids: [special.id], missing: [] });
  const other = mentionToken(assets[1]);
  assert.equal(removeMentions(`参考 ${token} 的布局、${other} 的风格，再看 ${token}。`, special.id, [special, assets[1]]), `参考  的布局、${other} 的风格，再看 。`);
});
