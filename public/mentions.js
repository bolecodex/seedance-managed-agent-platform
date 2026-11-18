const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const quote = value => String(value).replace(/\\/g, '\\\\').replace(/」/g, '\\」');

export function mentionContext(text, start, end = start) {
  if (start !== end) return null;
  const before = text.slice(0, start);
  const index = Math.max(before.lastIndexOf('@'), before.lastIndexOf('＠'));
  if (index < 0 || /[a-z\d_@＠./:+%\-]/i.test(before[index - 1] || '')) return null;
  const query = before.slice(index + 1);
  if (query.length > 180 || /[\r\n@＠「」，。；！？、]/u.test(query)) return null;
  return { start: index, end: start, query };
}

export function mentionKind(asset) {
  return ({ image: '图片', video: '视频', audio: '音频' })[asset.type?.split('/')[0]] || '文档';
}

export function mentionToken(asset, assets = []) {
  const duplicates = assets.filter(item => item.id !== asset.id && item.name === asset.name);
  let length = 8;
  while (duplicates.some(item => item.id.slice(0, length) === asset.id.slice(0, length)) && length < asset.id.length) length++;
  const suffix = duplicates.length ? ` · ${asset.id.slice(0, length)}` : '';
  return `@「${quote(asset.name + suffix)}」`;
}

export function mentionCandidates(assets, selected, query) {
  const words = normalize(query);
  const selectionOrder = new Map([...selected].map((id, index) => [id, index]));
  return assets.map((asset, index) => {
    const name = normalize(asset.name);
    const kind = mentionKind(asset);
    const searchable = normalize(`${asset.name} ${kind} ${asset.type} ${asset.collection === 'reference' ? '参考素材' : '人像角色'}`);
    const score = !words ? 0 : name === words ? 3 : name.startsWith(words) ? 2 : searchable.includes(words) ? 1 : -1;
    return { asset, score, index };
  }).filter(item => item.score >= 0).sort((a, b) => b.score - a.score || Number(selected.has(b.asset.id)) - Number(selected.has(a.asset.id)) || (selectionOrder.get(a.asset.id) ?? a.index) - (selectionOrder.get(b.asset.id) ?? b.index)).map(item => item.asset);
}

// Resolve visible tokens to real asset IDs, including names containing spaces or quotes.
export function resolveMentions(text, assets) {
  const ids = new Set();
  const missing = [];
  for (const match of text.matchAll(/[@＠]「((?:\\[\s\S]|[^\\」])*)」/gu)) {
    const label = match[1].replace(/\\([\s\S])/g, '$1');
    let matches = assets.filter(asset => asset.name === label);
    if (!matches.length) matches = assets.filter(asset => label.startsWith(`${asset.name} · `) && label.slice(asset.name.length + 3).length >= 8 && asset.id.startsWith(label.slice(asset.name.length + 3)));
    if (matches.length === 1) ids.add(matches[0].id);
    else missing.push(match[0]);
  }
  return { ids: [...ids], missing };
}

export function removeMentions(text, id, assets) {
  return text.replace(/[@＠]「((?:\\[\s\S]|[^\\」])*)」/gu, token => resolveMentions(token, assets).ids.includes(id) ? '' : token);
}
