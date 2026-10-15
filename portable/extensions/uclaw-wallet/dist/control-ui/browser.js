// 原生 Control UI 模块：使用官方 host.ui 与经过鉴权的插件 session-action transport。
// 无跨源请求、iframe 或业务逻辑副本；钱包动作均由共享 wallet-client 实现。
const pluginId = 'uclaw-wallet';

async function invoke(host, actionId, payload = {}) {
  host.signal.throwIfAborted();
  const result = await host.request('plugins.sessionAction', { pluginId, actionId, payload });
  host.signal.throwIfAborted();
  if (!result || result.ok !== true) throw new Error(result?.error || '钱包操作失败');
  if (result.result?.ok === false) throw new Error(result.result.error || '钱包操作失败');
  return result.result;
}

function mountWallet(container, context) {
  const host = context.host;
  let disposed = false, generation = 0;
  const root = document.createElement('section');
  root.className = 'uclaw-wallet-page';
  root.innerHTML = `<h1>虾盘云 · 设备钱包</h1>
    <p>领取钱包或启用已有密钥后，即可回到对话使用默认模型。</p>
    <div class="uclaw-wallet-card"><h2>默认模型</h2><p>deepseek-v4-flash</p></div>
    <div class="uclaw-wallet-card"><h2>设备钱包</h2><p data-role="status">正在读取本地状态…</p>
      <div class="uclaw-wallet-actions">
        <button data-action-id="uclaw.wallet.claim">一键领取额度</button>
        <button data-action-id="uclaw.wallet.balance">查询余额</button>
        <button data-action-id="uclaw.wallet.recharge">一键充值</button>
        <button data-action-id="uclaw.wallet.copy-key">复制密钥</button>
        <button data-action-id="uclaw.wallet.rotate">换一把密钥</button>
      </div><p data-role="balance"></p>
      <label>已有虾盘云密钥<input type="password" autocomplete="off" placeholder="sk-…" data-role="key"></label>
      <button data-action-id="uclaw.wallet.adopt">启用这把密钥</button>
      <p class="uclaw-wallet-hint">密钥就是钱包，请复制备份。换电脑后可用同一密钥恢复余额。</p>
      <details><summary>钱包管理</summary><button data-action-id="uclaw.wallet.reset">移除本机钱包</button></details>
    </div><p role="status" data-role="message"></p>`;
  container.appendChild(root);
  const status = root.querySelector('[data-role="status"]');
  const message = root.querySelector('[data-role="message"]');
  const keyInput = root.querySelector('[data-role="key"]');
  const buttons = [...root.querySelectorAll('button')];
  const live = () => !disposed && !context.signal.aborted;
  function permissions() {
    buttons.forEach((button) => {
      const query = /\.balance$/.test(button.dataset.actionId);
      button.disabled = !host.connection.connected || !(query ? host.connection.canRead : host.connection.canWrite);
    });
  }
  async function refresh() {
    const current = ++generation;
    if (!host.connection.connected) { status.textContent = '请先连接 OpenClaw'; return; }
    try {
      const state = await invoke(host, 'status');
      if (!live() || current !== generation) return;
      status.textContent = state.hasWallet ? '设备钱包已启用 · ' + state.maskedKey : '尚未启用设备钱包';
      root.querySelector('[data-action-id="uclaw.wallet.claim"]').hidden = state.hasWallet;
    } catch (error) { if (live() && current === generation) status.textContent = host.redact(error.message); }
    permissions();
  }
  async function click(event) {
    const button = event.target.closest('button[data-action-id]');
    if (!button || button.disabled) return;
    const action = button.dataset.actionId.replace('uclaw.wallet.', '');
    let payload = {}, popup;
    if (action === 'rotate' && !window.confirm('换一把新密钥？旧密钥会失效，余额会保留。请确认已更新其他使用旧密钥的设备。')) return;
    if (action === 'reset' && !window.confirm('确认已复制备份密钥？移除只清本机记录，旧钱包仍可凭密钥恢复。')) return;
    if (action === 'rotate' || action === 'reset') payload.confirmed = true;
    if (action === 'adopt') {
      payload.key = keyInput.value.trim();
      if (!payload.key) { message.textContent = '请先填写已有密钥'; return; }
    }
    // 同步打开空白页，避免异步拿到充值链接后被浏览器拦截。
    if (action === 'recharge') popup = window.open('about:blank', '_blank');
    button.disabled = true;
    message.textContent = '处理中…';
    try {
      const result = await invoke(host, action, payload);
      if (!live()) { popup?.close(); return; }
      if (action === 'recharge') {
        if (popup) { popup.opener = null; popup.location.href = result.url; }
        else message.textContent = '浏览器阻止了新窗口，请允许弹出窗口后重试';
      } else if (action === 'copy-key') {
        await navigator.clipboard.writeText(result.key);
        message.textContent = '密钥已复制，请妥善备份';
      } else if (action === 'balance') {
        root.querySelector('[data-role="balance"]').textContent = '可用 $' + (result.remainingUsd ?? '—') + '，已用 $' + (result.usedUsd ?? '—');
        message.textContent = '余额已更新';
      } else {
        keyInput.value = '';
        message.textContent = action === 'reset' ? '本机钱包已移除' : '钱包已更新，默认模型已配置，可回到对话使用';
        await refresh();
      }
      if (action === 'recharge' && popup) message.textContent = '充值页面已打开';
    } catch (error) { popup?.close(); if (live()) message.textContent = host.redact(error.message); }
    finally { if (live()) permissions(); }
  }
  root.addEventListener('click', click);
  let connected = host.connection.connected;
  const unsubscribe = host.subscribe(() => {
    permissions();
    if (connected !== host.connection.connected) { connected = host.connection.connected; refresh(); }
  });
  refresh(); permissions();
  return { update(next) { context = next; }, focus() { keyInput.focus(); }, dispose() { disposed = true; ++generation; unsubscribe(); root.removeEventListener('click', click); root.remove(); } };
}

function mountAccessory(container, context) {
  const link = document.createElement('a');
  link.className = 'uclaw-wallet-header-link';
  link.textContent = '设备钱包 · 充值';
  link.dataset.actionId = 'uclaw.wallet.open';
  link.href = context.host.navigation.pageHref({ id: 'wallet' });
  container.appendChild(link);
  const click = (event) => { event.preventDefault(); context.host.navigation.openPage({ id: 'wallet' }); };
  link.addEventListener('click', click);
  return { dispose() { link.removeEventListener('click', click); link.remove(); } };
}

export default {
  id: pluginId,
  activate(host) {
    const disposers = [
      host.ui.registerPage({ id: 'wallet', label: '设备钱包', mount: mountWallet }),
      host.ui.registerNavigation({ id: 'wallet', label: '设备钱包', page: { id: 'wallet' }, icon: 'wallet', order: 1 }),
      host.ui.registerAccessory({ id: 'wallet-link', placement: 'session-header', mount: mountAccessory }),
    ];
    return () => disposers.reverse().forEach((dispose) => dispose());
  },
};
