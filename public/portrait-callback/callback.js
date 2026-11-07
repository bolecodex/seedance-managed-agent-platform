const parameters = new URLSearchParams(location.search);
const values = parameters.getAll('resultCode');
const resultCode = values.length === 1 && /^\d{1,8}$/.test(values[0]) ? values[0] : '';
history.replaceState(null, '', location.pathname);

let description = '请回到发起认证的创作工作台，查询本人认证结果。';
if (resultCode === '10000') {
  document.querySelector('#callbackTitle').textContent = '检测结束，回工作台核验';
  description = 'H5 页面返回了通过检测的状态。请回到工作台，由服务端查询真人素材组并确认认证结果。';
} else if (resultCode) {
  document.body.dataset.result = 'attention';
  document.querySelector('#callbackTitle').textContent = '检测返回，请核对认证状态';
  description = 'H5 页面未返回通过检测的状态。请回到工作台核对；如果检测未通过，需重新创建认证链接。';
}
document.querySelector('#callbackDescription').textContent = description;
if (resultCode) {
  const badge = document.querySelector('#resultCode');
  badge.textContent = `H5 RETURN CODE / ${resultCode}`;
  badge.hidden = false;
}
document.querySelector('#copyStatus').onclick = async () => {
  const message = document.querySelector('#copyStatusMessage');
  try {
    await navigator.clipboard.writeText(`${description}${resultCode ? ` H5 返回码：${resultCode}。` : ''} 最终认证结果须由工作台服务端核验。`);
    message.textContent = '已复制状态说明，不包含认证凭证。';
  } catch { message.textContent = '请直接回到工作台查询，无需复制认证网址。'; }
};
