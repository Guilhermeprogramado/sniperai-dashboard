const LATEST_SERVER_DELAY = 0;

const el = (id) => document.getElementById(id);
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

let autoscroll = true;
const logBox = el('logBox');

// ---------- WebSocket ----------
ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello' })));
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'log': addLog(msg.data); break;
    case 'status': updateStatus(msg.data); break;
    case 'wallet': updateWallet(msg.data); break;
    case 'config': loadConfigIntoForm(msg.data); break;
    case 'state': updateState(msg.data); break;
    case 'trade': addTradePoint(msg.data); break;
  }
});

// ---------- Equity chart ----------
let equityChart = null;
let equityData = [];

function initChart() {
  const ctx = el('equityChart');
  if (!ctx) return;
  equityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Saldo (SOL)',
        data: [],
        borderColor: '#00e676',
        backgroundColor: 'rgba(0, 230, 118, 0.08)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${c.parsed.y} SOL`,
            afterLabel: (c) => {
              const t = equityData[c.dataIndex];
              return t ? `P&L: ${t.pnlSOL >= 0 ? '+' : ''}${t.pnlSOL} SOL (${t.pnlPct}%)` : '';
            }
          }
        }
      },
      scales: {
        x: { ticks: { display: false }, grid: { color: '#232331' } },
        y: { ticks: { color: '#7a7a8e', font: { family: 'JetBrains Mono' } }, grid: { color: '#232331' } }
      }
    }
  });
}

function setEquity(data) {
  if (!data) return;
  equityData = data;
  renderEquity();
}

function addTradePoint(entry) {
  if (!entry) return;
  equityData.push(entry);
  // Duplica o último ponto e adiciona um zero-transiente? Não — apenas re-renderiza.
  renderEquity();
}

function renderEquity() {
  if (!equityChart) initChart();
  if (!equityChart) return;
  const labels = equityData.map((_, i) => `#${i + 1}`);
  const pts = equityData.map(t => t.equity);
  equityChart.data.labels = labels;
  equityChart.data.datasets[0].data = pts;
  equityChart.update('none');

  // Legenda P&L total
  const total = equityData.reduce((a, t) => a + t.pnlSOL, 0);
  const elPnl = el('pnlTotal');
  if (elPnl) {
    elPnl.textContent = `P&L: ${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL`;
    elPnl.style.color = total >= 0 ? 'var(--primary)' : 'var(--accent)';
  }
  const label = el('equityLabel');
  if (label && pts.length) {
    label.textContent = `${pts[pts.length - 1].toFixed(4)} SOL`;
  }
}

// ---------- API helpers ----------
const api = async (path, body) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

// ---------- Wallet: Phantom / Solflare ----------
function findProvider(name) {
  if (name === 'phantom') {
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
  }
  if (name === 'solflare') {
    if (window.solflare?.isSolflare) return window.solflare;
    if (window.solana?.isSolflare) return window.solana;
  }
  return null;
}

// Phantom injeta o provider de forma assíncrona; aguarda até ~4s.
function waitForProvider(name, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const p = findProvider(name);
    if (p) return resolve(p);
    const started = Date.now();
    const iv = setInterval(() => {
      const found = findProvider(name);
      if (found) { clearInterval(iv); resolve(found); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(null); }
    }, 150);
  });
}

async function connectBrowser(name) {
  const provider = await waitForProvider(name);
  if (!provider) {
    const url = name === 'phantom' ? 'https://phantom.app/' : 'https://solflare.com/';
    window.open(url, '_blank');
    addToast(`Carteira ${name} não detectada. Instale a extensão e recarregue a página.`, 'error');
    return;
  }
  try {
    // Tenta reconectar silenciosamente (se o usuário já aprovou antes).
    let publicKey = null;
    if (provider.isConnected && provider.publicKey) {
      publicKey = provider.publicKey.toString();
    } else {
      try { await provider.connect({ onlyIfTrusted: true }); } catch (e) {}
      if (!provider.publicKey) {
        const resp = await provider.connect();
        publicKey = resp?.publicKey?.toString?.() || resp?.publicKey || null;
      } else {
        publicKey = provider.publicKey.toString();
      }
    }
    if (!publicKey) throw new Error('Sem publicKey retornada pela carteira');
    await api('/api/wallet/connect', { viewOnly: true, publicKey });
    await api('/api/wallet/refresh');
    addToast(`Carteira ${name} conectada (somente leitura)`, 'success');
  } catch (e) {
    addToast(`Falha ao conectar: ${e.message}`, 'error');
  }
}

el('connectPhantomBtn').addEventListener('click', () => connectBrowser('phantom'));
el('connectSolflareBtn').addEventListener('click', () => connectBrowser('solflare'));

// ---------- Wallet: secret (server-side) ----------
el('connectSecretBtn').addEventListener('click', async () => {
  const secret = el('secretInput').value.trim();
  if (!secret) return;
  try {
    const data = await api('/api/wallet/connect', { secret });
    addToast(`Carteira carregada: ${short(data.publicKey)}`, 'success');
    el('secretInput').value = '';
  } catch (e) {
    addToast(e.message, 'error');
  }
});

// ---------- Disconnect / refresh ----------
el('disconnectBtn').addEventListener('click', async () => {
  try { await api('/api/wallet/disconnect'); addToast('Desconectado', 'info'); }
  catch (e) { addToast(e.message, 'error'); }
});

el('refreshWalletBtn').addEventListener('click', async () => {
  try { await api('/api/wallet/refresh'); }
  catch (e) { addToast(e.message, 'error'); }
});

// ---------- Environment switch (Simulado / Real) ----------
// selectedMode decide o que o botão Start enviará: 'simulator' | 'real'
let selectedMode = 'simulator';

function updateModeBadge(mode) {
  const badge = el('modeBadge');
  if (!badge) return;
  const isReal = mode === 'real' || mode === 'live_mainnet';
  badge.textContent = `MODO ATUAL: ${isReal ? 'REAL' : 'SIMULADOR'}`;
  badge.className = `mode-badge ${isReal ? 'mode-real' : 'mode-sim'}`;
}

function applyEnv(env) {
  const isReal = env === 'real';
  selectedMode = isReal ? 'real' : 'simulator';
  document.body.classList.toggle('env-real', isReal);
  el('envSimBtn').classList.toggle('active', !isReal);
  el('envRealBtn').classList.toggle('active', isReal);
  updateModeBadge(selectedMode);
}

el('envSimBtn').addEventListener('click', () => {
  applyEnv('simulado');
  try { void api('/api/config', { mode: 'paper_mainnet', simulationMode: true, useDevnet: false }); }
  catch (e) { addToast(e.message, 'error'); }
});
el('envRealBtn').addEventListener('click', () => {
  applyEnv('real');
  addToast('Ambiente REAL selecionado. Ao iniciar, será pedida confirmação.', 'error');
  try { void api('/api/config', { mode: 'paper_mainnet', simulationMode: false, useDevnet: false }); }
  catch (e) { addToast(e.message, 'error'); }
});

// ---------- Save config ----------
const CFG_MAP = [
  ['cfgBuy', 'buyAmountSol', parseFloat],
  ['cfgSellTrigger', 'sellTriggerPct', parseFloat],
  ['cfgStopLoss', 'stopLossPct', parseFloat],
  ['cfgSlippage', 'slippageBps', parseInt],
  ['cfgMaxBC', 'maxBondingCurve', parseInt],
  ['cfgFee', 'priorityFeeLamports', parseInt],
  ['cfgRpc', 'rpcUrl', (v) => v.trim()]
];

el('saveConfigBtn').addEventListener('click', async () => {
  const cfg = {};
  for (const [id, key, fn] of CFG_MAP) {
    const val = el(id).value;
    if (val !== '') cfg[key] = fn(val);
  }
  if (el('autoSellToggle')) cfg.autoSellOnBuy = el('autoSellToggle').checked;
  try {
    await api('/api/config', cfg);
    addToast('Configurações salvas', 'success');
  } catch (e) { addToast(e.message, 'error'); }
});

function loadConfigIntoForm(cfg) {
  for (const [id, key] of CFG_MAP) {
    if (cfg[key] !== undefined) el(id).value = cfg[key];
  }
  if (cfg.autoSellOnBuy !== undefined && el('autoSellToggle')) el('autoSellToggle').checked = cfg.autoSellOnBuy;
  // Sincroniza o seletor de ambiente conforme a config vinda do servidor
  if (cfg.mode !== undefined) {
    const real = cfg.mode !== 'paper_mainnet' && cfg.mode !== 'mock';
    document.body.classList.toggle('env-real', real);
    el('envSimBtn')?.classList.toggle('active', !real);
    el('envRealBtn')?.classList.toggle('active', real);
    selectedMode = real ? 'real' : 'simulator';
    updateModeBadge(selectedMode);
  }
}

// ---------- Bot control ----------
function openModal() { el('confirmModal').classList.remove('hidden'); el('confirmInput').focus(); }
function closeModal() { el('confirmModal').classList.add('hidden'); el('confirmInput').value = ''; el('confirmRealBtn').disabled = true; }

el('startBtn').addEventListener('click', async () => {
  if (selectedMode === 'real') { openModal(); return; }
  // simulator: inicia direto (backend força paper_mainnet)
  try { await api('/api/bot/start', { mode: 'simulator' }); addToast('Bot iniciado (SIMULADOR — sem transações reais)', 'success'); }
  catch (e) { addToast(e.message, 'error'); }
});

el('confirmInput').addEventListener('input', (e) => {
  el('confirmRealBtn').disabled = e.target.value.trim() !== 'REAL';
});
el('cancelRealBtn').addEventListener('click', closeModal);
el('confirmRealBtn').addEventListener('click', async () => {
  if (el('confirmInput').value.trim() !== 'REAL') { addToast('Confirmação inválida', 'error'); return; }
  closeModal();
  try { await api('/api/bot/start', { mode: 'real', confirmation: 'REAL' }); addToast('Bot iniciado em modo REAL', 'error'); }
  catch (e) { addToast(e.message, 'error'); }
});

el('stopBtn').addEventListener('click', async () => {
  try { await api('/api/bot/stop'); addToast('Bot parado', 'info'); }
  catch (e) { addToast(e.message, 'error'); }
});

// ---------- UI updates ----------
function updateWallet(w) {
  const disc = el('walletDisconnected');
  const conn = el('walletConnected');
  if (w.publicKey) {
    disc.classList.add('hidden');
    conn.classList.remove('hidden');
    el('walletAddr').textContent = short(w.publicKey);
    el('walletBalance').textContent = `${w.balanceSOL.toFixed(4)} SOL`;
    const list = el('tokensList');
    if (w.tokens && w.tokens.length) {
      list.innerHTML = w.tokens.map(t =>
        `<div class="token-item"><span>${short(t.mint, 16)}</span><span>${t.amount.toFixed(4)}</span></div>`
      ).join('');
    } else {
      list.innerHTML = '<span class="muted">Nenhum</span>';
    }
    el('startBtn').disabled = false;
  } else {
    disc.classList.remove('hidden');
    conn.classList.add('hidden');
    el('startBtn').disabled = true;
  }
}

function updateState(state) {
  el('statState').textContent = state;
  el('statState').className = 'stat-val state-' + state;
  el('startBtn').disabled = (state === 'searching' || state === 'trading');
  el('stopBtn').disabled = (state === 'idle');
}

function updateStatus(s) {
  el('netLabel').textContent = `${s.network} · ${s.executionMode || s.mode || ''}`;
  if (s.sendTransactions !== undefined) updateModeBadge(s.sendTransactions ? 'live_mainnet' : 'paper_mainnet');
  if (s.state) updateState(s.state);
  el('statCycles').textContent = s.tradeCount ?? 0;
  el('statTrades').textContent = s.monitored ?? 0;
  if (Array.isArray(s.history) && s.history.length !== equityData.length) {
    setEquity(s.history);
  }
  const wsDot = el('wsDot');
  if (wsDot) {
    wsDot.style.background = s.wsConnected ? 'var(--primary)' : 'var(--warn)';
    wsDot.style.boxShadow = `0 0 8px ${s.wsConnected ? 'var(--primary)' : 'var(--warn)'}`;
  }
}

// ---------- Log ----------
function addLog(entry) {
  const time = new Date(entry.ts).toLocaleTimeString('pt-BR');
  const line = document.createElement('div');
  line.className = `log-line log-${entry.type}`;
  line.innerHTML = `<span class="ts">[${time}]</span> <span class="msg">${escapeHtml(entry.message)}</span>`;
  logBox.appendChild(line);
  capLog();
  if (autoscroll) logBox.scrollTop = logBox.scrollHeight;
  el('logCount').textContent = `(${logBox.children.length})`;
}

const LOG_MAX = 800;
function capLog() {
  while (logBox.children.length > LOG_MAX) logBox.removeChild(logBox.firstChild);
}

el('clearLogBtn').addEventListener('click', async () => {
  logBox.innerHTML = '';
  el('logCount').textContent = '';
  equityData = [];
  if (equityChart) {
    equityChart.data.labels = [];
    equityChart.data.datasets[0].data = [];
    equityChart.update('none');
  }
  const elPnl = el('pnlTotal');
  if (elPnl) elPnl.textContent = 'P&L: 0.0000 SOL';
  const label = el('equityLabel');
  if (label) label.textContent = '';
  try { await api('/api/history/clear'); } catch (e) {}
});
el('autoscrollBtn').addEventListener('click', (e) => {
  autoscroll = e.target.dataset.on !== '1';
  e.target.dataset.on = autoscroll ? '1' : '0';
  e.target.textContent = `Auto-scroll: ${autoscroll ? 'ON' : 'OFF'}`;
});

// ---------- Toast ----------
let toastEl;
function addToast(msg, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  const t = document.createElement('div');
  t.className = `toast-item toast-${type}`;
  t.textContent = msg;
  toastEl.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3200);
}

// ---------- utils ----------
function short(addr, n = 8) {
  if (!addr) return '—';
  return addr.length > n * 2 + 3 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;'
  })[c]);
}
