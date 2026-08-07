import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SniperBot, DEFAULTS } from './src/bot.js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4178;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const bot = new SniperBot();
const envConfig = {
  useDevnet: process.env.USE_DEVNET ? process.env.USE_DEVNET === 'true' : undefined,
  simulationMode: process.env.SIMULATION_MODE ? process.env.SIMULATION_MODE === 'true' : undefined,
  mode: process.env.AGENT_MODE || undefined,
  allowRealMode: process.env.ALLOW_REAL_MODE !== undefined ? process.env.ALLOW_REAL_MODE === 'true' : undefined,
  rpcUrl: process.env.RPC_URL || undefined,
  mainnetRpcUrl: process.env.MAINNET_RPC_URL || undefined,
  mainnetWsUrl: process.env.MAINNET_WS_URL || undefined,
  pumpFunProgram: process.env.PUMP_FUN_PROGRAM || undefined,
  commitment: process.env.COMMITMENT || undefined,
  enableLiveTrading: process.env.ENABLE_LIVE_TRADING !== undefined ? process.env.ENABLE_LIVE_TRADING === 'true' : undefined,
  requireLiveConfirmation: process.env.REQUIRE_LIVE_CONFIRMATION !== undefined ? process.env.REQUIRE_LIVE_CONFIRMATION === 'true' : undefined,
  iUnderstandLiveRisk: process.env.I_UNDERSTAND_LIVE_RISK || undefined,
  paperInitialSol: process.env.PAPER_INITIAL_SOL ? parseFloat(process.env.PAPER_INITIAL_SOL) : undefined,
  paperFeeBps: process.env.PAPER_FEE_BPS ? parseInt(process.env.PAPER_FEE_BPS) : undefined,
  paperSlippageBps: process.env.PAPER_SLIPPAGE_BPS ? parseInt(process.env.PAPER_SLIPPAGE_BPS) : undefined,
  paperLatencyMs: process.env.PAPER_LATENCY_MS ? parseInt(process.env.PAPER_LATENCY_MS) : undefined,
  maxSolPerTrade: process.env.MAX_SOL_PER_TRADE ? parseFloat(process.env.MAX_SOL_PER_TRADE) : undefined,
  maxDailyLossSol: process.env.MAX_DAILY_LOSS_SOL ? parseFloat(process.env.MAX_DAILY_LOSS_SOL) : undefined,
  maxOpenPositions: process.env.MAX_OPEN_POSITIONS ? parseInt(process.env.MAX_OPEN_POSITIONS) : undefined,
  buyAmountSol: process.env.BUY_AMOUNT_SOL ? parseFloat(process.env.BUY_AMOUNT_SOL) : undefined,
  sellTriggerPct: process.env.SELL_TRIGGER_PCT ? parseFloat(process.env.SELL_TRIGGER_PCT) : undefined,
  stopLossPct: process.env.STOP_LOSS_PCT ? parseFloat(process.env.STOP_LOSS_PCT) : undefined,
  slippageBps: process.env.SLIPPAGE_BPS ? parseInt(process.env.SLIPPAGE_BPS) : undefined,
  priorityFeeLamports: process.env.PRIORITY_FEE_LAMPORTS ? parseInt(process.env.PRIORITY_FEE_LAMPORTS) : undefined,
  maxBondingCurve: process.env.MAX_BONDING_CURVE ? parseInt(process.env.MAX_BONDING_CURVE) : undefined,
  autoSellOnBuy: process.env.AUTO_SELL_ON_BUY !== undefined ? process.env.AUTO_SELL_ON_BUY === 'true' : undefined
};
const cleanEnvConfig = Object.fromEntries(Object.entries(envConfig).filter(([, v]) => v !== undefined));
bot.updateConfig(cleanEnvConfig);

// --- WebSocket broadcast ---
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'config', data: bot.config }));
        ws.send(JSON.stringify({ type: 'wallet', data: bot.wallet }));
        ws.send(JSON.stringify({ type: 'status', data: statusPayload() }));
      }
    } catch (e) {}
  });
});

const broadcast = (type, data) => {
  const payload = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
};

const statusPayload = () => ({
  state: bot.state, running: bot.running, tradeCount: bot.tradeCount,
  profitLoss: bot.profitLoss, equity: bot.equity, wsConnected: bot.wsConnected, monitored: bot.monitoredTokens.size,
  history: bot.tradeHistory,
  network: bot.config.useDevnet ? 'DEVNET' : 'MAINNET',
  mode: bot.config.mode || (bot.config.simulationMode ? 'mock' : 'paper_mainnet')
});

bot.emit = (type, data) => {
  broadcast(type, data);
  if (type === 'wallet' || type === 'config') {} // já broadcastado
  if (type === 'status') broadcast('status', data);
};

// --- REST API ---
app.post('/api/wallet/connect', (req, res) => {
  const { secret, viewOnly, publicKey } = req.body || {};
  try {
    if (viewOnly && publicKey) {
      bot.setViewOnlyWallet(publicKey);
      return res.json({ ok: true, publicKey: bot.wallet.publicKey, viewOnly: true });
    }
    if (!secret) return res.status(400).json({ ok: false, error: 'secret é obrigatório' });
    const ok = bot.loadWalletFromSecret(secret);
    if (!ok) return res.status(400).json({ ok: false, error: 'Falha ao carregar carteira' });
    res.json({ ok: true, publicKey: bot.wallet.publicKey });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/wallet/disconnect', (req, res) => {
  bot.wallet = { provided: false, publicKey: null, balanceSOL: 0, tokens: [] };
  bot.keypair = null;
  bot.emitWallet();
  res.json({ ok: true });
});

app.post('/api/wallet/refresh', async (req, res) => {
  if (!bot.wallet.publicKey) return res.status(400).json({ ok: false, error: 'sem carteira' });
  if (!bot.connection) {
    try { await bot.connect(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  await bot.refreshWallet();
  res.json({ ok: true, wallet: bot.wallet });
});

app.get('/api/config', (req, res) => res.json(bot.config));

app.post('/api/config', (req, res) => {
  bot.updateConfig(req.body || {});
  res.json({ ok: true, config: bot.config });
});

app.post('/api/bot/start', async (req, res) => {
  const { mode, confirmation } = req.body || {};
  try {
    if (!bot.wallet.publicKey) return res.status(400).json({ ok: false, error: 'Conecte a carteira primeiro' });

    // O backend NÃO confia no botão: decide a execução aqui.
    if (mode === 'simulator') {
      await bot.start({ mode: 'simulator' });
      return res.json({ ok: true, executionMode: 'paper_mainnet', sendTransactions: false });
    }

    if (mode === 'real') {
      if (process.env.ALLOW_REAL_MODE !== 'true') {
        return res.status(400).json({ ok: false, error: 'Modo real não permitido pelo servidor (ALLOW_REAL_MODE != true).' });
      }
      if (process.env.ENABLE_LIVE_TRADING !== 'true') {
        return res.status(400).json({ ok: false, error: 'ENABLE_LIVE_TRADING não está true.' });
      }
      if ((process.env.I_UNDERSTAND_LIVE_RISK || '').toUpperCase() !== 'YES') {
        return res.status(400).json({ ok: false, error: 'Você precisa confirmar que entende o risco (I_UNDERSTAND_LIVE_RISK=YES).' });
      }
      if (confirmation !== 'REAL') {
        return res.status(400).json({ ok: false, error: 'Confirmação inválida. Digite REAL para operar.' });
      }
      if (!process.env.MAINNET_RPC_URL) {
        return res.status(400).json({ ok: false, error: 'RPC mainnet não configurado (MAINNET_RPC_URL).' });
      }
      if (!process.env.PUMP_FUN_PROGRAM) {
        return res.status(400).json({ ok: false, error: 'PUMP_FUN_PROGRAM não configurado.' });
      }
      bot.updateConfig({ mode: 'paper_mainnet' });
      await bot.start({ mode: 'real' });
      return res.json({ ok: true, executionMode: 'live_mainnet', sendTransactions: true });
    }

    return res.status(400).json({ ok: false, error: 'Modo inválido. Use "simulator" ou "real".' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/bot/stop', (req, res) => {
  bot.stop();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json(statusPayload()));
app.get('/api/history', (req, res) => res.json(bot.tradeHistory));

app.post('/api/validate', async (req, res) => {
  try {
    await bot.validateRpc();
    await bot.validatePumpProgram();
    res.json({ ok: true, message: 'RPC e PUMP_FUN_PROGRAM válidos', pumpFunProgram: bot.config.pumpFunProgram });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/history/clear', (req, res) => {
  bot.tradeHistory = [];
  bot.profitLoss = 0;
  bot.equity = 0;
  bot.tradeCount = 0;
  bot.emitStatus();
  res.json({ ok: true, history: [] });
});

// --- Serve frontend ---
const pub = path.join(__dirname, 'public');
app.use(express.static(pub));
app.get('*', (req, res) => res.sendFile(path.join(pub, 'index.html')));

server.listen(PORT, () => {
  console.log(`SniperAI Dashboard rodando em http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});
