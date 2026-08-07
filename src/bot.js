import {
  Keypair, Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { default as WebSocket } from 'ws';
import axios from 'axios';
import bs58 from 'bs58';

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

// Modos suportados
const MODES = ['mock', 'paper_mainnet', 'simulate_rpc', 'live_mainnet'];

const DEFAULTS = {
  allowRealMode: false,        // ALLOW_REAL_MODE
  agentMode: 'paper_mainnet',   // mock | paper_mainnet | simulate_rpc | live_mainnet
  simulationMode: true,          // compatibilidade reversa
  useDevnet: true,
  enableLiveTrading: false,
  requireLiveConfirmation: true,
  iUnderstandLiveRisk: false,
  commitment: 'confirmed',
  mainnetRpcUrl: '',             // MAINNET_RPC_URL
  mainnetWsUrl: '',              // MAINNET_WS_URL
  pumpFunProgram: PUMP_FUN_PROGRAM.toString(),
  buyAmountSol: 0.015,
  sellTriggerPct: 10,
  stopLossPct: 15,
  slippageBps: 500,
  priorityFeeLamports: 10000,
  maxBondingCurve: 15,
  autoSellOnBuy: true,
  monitorIntervalMs: 3000,
  // Paper trading
  paperInitialSol: 1.0,
  paperFeeBps: 100,
  paperSlippageBps: 50,
  paperLatencyMs: 250,
  // Risco
  maxSolPerTrade: 0.05,
  maxDailyLossSol: 0.20,
  maxOpenPositions: 3
};

export class SniperBot {
  constructor(emitter) {
    this.emit = emitter || (() => {});
    this.connection = null;
    this.keypair = null;
    this.ws = null;
    this.config = { ...DEFAULTS };
    // Flags de execução DEFINIDOS NO START (nunca pelo botão diretamente).
    // sendTransactions=false garante que nenhuma ordem real pode ser enviada.
    this.sendTransactions = false;
    this.executionMode = 'paper_mainnet'; // paper_mainnet | live_mainnet
    this.wallet = { provided: false, publicKey: null, balanceSOL: 0, tokens: [] };
    this.state = 'idle';
    this.running = false;
    this.tradeCount = 0;
    this.profitLoss = 0;
    this.tradeHistory = [];
    this.decisionLog = [];
    this.equity = 0;
    this.paperCash = 0;
    this.paperPositions = new Map();
    this.monitoredTokens = new Map();
    this.wsConnected = false;
    this.startOfDayPnl = 0;
  }

  log(message, type = 'info') {
    this.emit('log', { ts: new Date().toISOString(), message, type });
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
  setState(s) { this.state = s; this.emit('state', s); }
  emitWallet() { this.emit('wallet', { ...this.wallet }); }
  emitConfig() { this.emit('config', { ...this.config }); }
  emitStatus() {
    this.emit('status', {
      state: this.state, running: this.running, tradeCount: this.tradeCount,
      profitLoss: this.profitLoss, equity: this.equity,
      network: this.config.useDevnet ? 'DEVNET' : 'MAINNET',
      mode: this.config.mode,
      executionMode: this.executionMode,
      sendTransactions: this.sendTransactions,
      wsConnected: this.wsConnected,
      monitored: this.monitoredTokens.size
    });
  }

  // ——— Registro de decisão estruturada ———
  logDecision(entry) {
    const base = {
      timestamp: new Date().toISOString(),
      mode: this.config.mode,
      mint: entry.mint || null,
      side: entry.side || null,
      signal: entry.signal || null,
      requestId: this.uid()
    };
    const full = { ...base, ...entry };
    this.log(`[DECISION] ${JSON.stringify(full)}`, 'info');
    this.emit('log', { ts: new Date().toISOString(), message: `📊 decision: ${full.side || ''} ${full.mint || ''} signal=${full.signal || ''} price=${full.price ?? ''}`, type: 'info' });
  }

  // ——— Registra fill virtual (paper) ou real, atualiza equity ———
  recordTrade(mint, pnlPct, pnlSOL, side = 'auto') {
    if (this.equity === 0) this.equity = this.wallet.balanceSOL || this.config.buyAmountSol;
    this.equity += pnlSOL;
    this.profitLoss += pnlSOL;
    this.tradeCount++;
    const entry = {
      ts: Date.now(),
      mint: String(mint || '').slice(0, 16),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      pnlSOL: parseFloat(pnlSOL.toFixed(6)),
      equity: parseFloat(this.equity.toFixed(6)),
      mode: this.executionMode || this.config.mode,
      sentToChain: this.sendTransactions,
      executionMode: this.executionMode || 'paper_mainnet',
      side
    };
    this.tradeHistory.push(entry);
    if (this.tradeHistory.length > 500) this.tradeHistory.shift();
    this.emit('trade', entry);
    this.emitStatus();
    return entry;
  }

  rpcUrl() {
    if (this.config.useDevnet) return 'https://api.devnet.solana.com';
    if (this.config.mainnetRpcUrl) return this.config.mainnetRpcUrl;
    return 'https://api.mainnet-beta.solana.com';
  }
  wsUrl() {
    if (!this.config.useDevnet && this.config.mainnetWsUrl) return this.config.mainnetWsUrl;
    return this.rpcUrl().replace('https://', 'wss://').replace('http://', 'ws://');
  }

  // ——— Wallet ———
  loadWalletFromSecret(secret) {
    try {
      let arr;
      if (typeof secret === 'string') {
        const t = secret.trim();
        arr = t.startsWith('[') ? JSON.parse(t) : bs58.decode(t);
      } else if (Array.isArray(secret)) {
        arr = secret;
      } else {
        throw new Error('Formato não suportado. Use base58 ou array JSON.');
      }
      this.keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
      this.wallet.provided = true;
      this.wallet.publicKey = this.keypair.publicKey.toString();
      this.log(`Carteira carregada: ${this.wallet.publicKey}`, 'success');
      this.emitWallet();
      return true;
    } catch (e) {
      this.log(`Falha ao carregar carteira: ${e.message}`, 'error');
      return false;
    }
  }

  setViewOnlyWallet(publicKeyStr) {
    this.wallet.provided = true;
    this.wallet.viewOnly = true;
    this.wallet.publicKey = publicKeyStr;
    this.keypair = null;
    this.log(`Modo somente leitura: ${publicKeyStr}`, 'info');
    this.emitWallet();
  }

  async connect() {
    if (!this.wallet.publicKey) throw new Error('Nenhuma carteira carregada');
    this.connection = new Connection(this.rpcUrl(), { commitment: 'confirmed', wsEndpoint: this.wsUrl() });
    await this.connection.getLatestBlockhash();
    this.log(`Conectado à rede ${this.config.useDevnet ? 'DEVNET' : 'MAINNET'}`, 'success');
    await this.refreshWallet();
  }

  async refreshWallet() {
    if (!this.connection || !this.wallet.publicKey) return;
    try {
      const pubkey = new PublicKey(this.wallet.publicKey);
      // Em modo paper (simulador), não precisa ler saldo real; usa papel virtual.
      if (!this.sendTransactions) {
        this.wallet.balanceSOL = this.paperCash || this.config.paperInitialSol;
        this.emitWallet();
        return;
      }
      this.wallet.balanceSOL = (await this.connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
      this.wallet.tokens = tokenAccounts.value.map(acc => {
        const d = AccountLayout.decode(acc.account.data);
        return { mint: new PublicKey(d.mint).toString(), amount: Number(d.amount) / 1e6 };
      }).filter(t => t.amount > 0.0001);
      this.emitWallet();
    } catch (e) {
      this.log(`Erro ao atualizar carteira: ${e.message}`, 'error');
    }
  }

  updateConfig(newConfig) {
    // Sanity: mode deve estar em MODES
    if (newConfig.mode && !MODES.includes(newConfig.mode)) {
      delete newConfig.mode;
      this.log(`Modo "${newConfig.mode}" inválido. Mantendo "${this.config.mode}".`, 'error');
    }
    this.config = { ...this.config, ...newConfig };
    this.log('Configurações atualizadas.', 'info');
    this.emitConfig();
    this.emitStatus();
  }

  // ============================================================
  //  VALIDAÇÕES DE SEGURANÇA
  // ============================================================

  assertSafeMode() {
    if (this.sendTransactions || this.config.mode === 'live_mainnet') {
      if (!this.config.allowRealMode) {
        throw new Error('ALLOW_REAL_MODE precisa ser true para operar real.');
      }
      if (!this.config.enableLiveTrading) {
        throw new Error('ENABLE_LIVE_TRADING precisa estar true para operar real.');
      }
      if (!this.config.iUnderstandLiveRisk || String(this.config.iUnderstandLiveRisk).toUpperCase() !== 'YES') {
        throw new Error('Para operar real, defina I_UNDERSTAND_LIVE_RISK=YES.');
      }
      if (!this.config.mainnetRpcUrl) {
        throw new Error('MAINNET_RPC_URL é obrigatório em modo live.');
      }
      if (!this.config.pumpFunProgram) {
        throw new Error('PUMP_FUN_PROGRAM é obrigatório em modo live.');
      }
      if (!this.keypair) {
        throw new Error('AMBIENTE REAL: necessária a CHAVE PRIVADA da carteira para assinar transações.');
      }
    }
  }

  async validateRpc() {
    if (this.config.useDevnet) { this.log('Validação de RPC: usando devnet (sem exigência de MAINNET_RPC_URL).', 'info'); return true; }
    if (!this.config.mainnetRpcUrl) throw new Error('MAINNET_RPC_URL não configurado.');
    try {
      const conn = new Connection(this.config.mainnetRpcUrl, 'confirmed');
      const health = await conn.getSlot();
      const slot = health;
      this.log(`RPC mainnet OK — slot:${slot}`, 'success');
      return true;
    } catch (e) {
      throw new Error(`Falha ao validar RPC mainnet: ${e.message}`);
    }
  }

  async validatePumpProgram() {
    const pidStr = this.config.pumpFunProgram;
    if (!pidStr) throw new Error('PUMP_FUN_PROGRAM não configurado.');
    let pid;
    try { pid = new PublicKey(pidStr); } catch (e) { throw new Error(`PUMP_FUN_PROGRAM inválido: ${pidStr}`); }
    const conn = new Connection(this.rpcUrl());
    const info = await conn.getAccountInfo(pid);
    if (!info) throw new Error(`Programa não encontrado na ${this.config.useDevnet ? 'devnet' : 'mainnet'}: ${pidStr}.`);
    this.log(`Validação Pump.fun — executable=${info.executable} owner=${info.owner.toBase58()} dataLen=${info.data.length}`, 'info');
    if (!info.executable) throw new Error('A conta do programa existe, mas NÃO é executable.');
    if (info.owner.toBase58() !== UPGRADEABLE_LOADER) {
      this.log(`⚠️ Aviso: owner inesperado (${info.owner.toBase58()}) para programa.`, 'warn');
    }
    return true;
  }

  // ============================================================
  //  JUPITER SWAP — só usado em live_mainnet (ou simulate monta a tx)
  // ============================================================

  async getJupitQuote(inputMint, outputMint, amountLamports, slippageBps) {
    const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  }

  // Monta a tx de swap e retorna a tx serializada (sem enviar).
  async buildJupiterSwapTx(inputMint, outputMint, amountLamports, slippageBps) {
    const quote = await this.getJupitQuote(inputMint, outputMint, amountLamports, slippageBps);
    if (!quote?.swapTransaction) throw new Error('Jupiter: transação de swap não retornada');
    const res = await axios.post(JUPITER_SWAP_API, {
      quoteResponse: quote,
      userPublicKey: this.keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: this.config.priorityFeeLamports,
      dynamicComputeUnitLimit: true
    }, { timeout: 15000 });
    if (!res.data?.swapTransaction) throw new Error('Swap tx inválida');
    const buf = Buffer.from(res.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    const raw = tx.serialize({ requireAllSignatures: false });
    return { tx, quote, base64: res.data.swapTransaction };
  }

  async executeJupiterSwapLIVE(inputMint, outputMint, amountLamports, slippageBps) {
    if (!this.keypair) throw new Error('Sem keypair para swap LIVE.');
    const { tx } = await this.buildJupiterSwapTx(inputMint, outputMint, amountLamports, slippageBps);
    tx.sign([this.keypair]);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      maxRetries: 3, skipPreflight: false, preflightCommitment: 'confirmed'
    });
    const conf = await this.connection.confirmTransaction(sig, 'confirmed');
    if (conf.value.err) throw new Error(`Tx falhou: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  // ============================================================
  //  ROTEADOR DE COMPRA/VENDA POR MODO
  // ============================================================

  async buyToken(mint, solAmount) {
    this.log(`>>> [${this.executionMode}] COMPRANDO ${solAmount} SOL de ${mint.slice(0,16)}...`, 'buy');
    // Coveiro de segurança: se sendTransactions for false, é IMPOSSÍVEL assinar/enviar.
    if (!this.sendTransactions) {
      const feeSOL = (solAmount * this.config.paperFeeBps) / 10000;
      const slipSOL = (solAmount * this.config.paperSlippageBps) / 10000;
      await sleep(this.config.paperLatencyMs);
      this.log(`[paper] fill virtual: custo ${solAmount.toFixed(6)} + fee ${feeSOL.toFixed(6)} + slip ${slipSOL.toFixed(6)}`, 'sim');
      this.logDecision({
        mint, side: 'buy', signal: 'paper-fill', price: 1,
        expectedOut: solAmount, simulatedOut: solAmount - feeSOL - slipSOL,
        feeBps: this.config.paperFeeBps, slippageBps: this.config.paperSlippageBps,
        latencyMs: this.config.paperLatencyMs,
        sentToChain: false, executionMode: 'paper_mainnet'
      });
      return `SIM_${Date.now()}`;
    }
    // LIVE — somente se todas as travas estiverem ativas
    if (!this.enableLiveAssertion()) { this.log('Negando transação real: travas live insuficientes.', 'error'); return null; }
    try {
      const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
      const sig = await this.executeJupiterSwapLIVE(WRAPPED_SOL, mint, lamports, this.config.slippageBps);
      this.log(`COMPRA real: ${sig.slice(0,30)}...`, 'buy');
      this.logDecision({ mint, side: 'buy', signal: 'live-exec', expectedOut: solAmount, txSignature: sig, sentToChain: true, executionMode: 'live_mainnet' });
      return sig;
    } catch (e) {
      this.log(`Erro na compra real: ${e.message}`, 'error');
      return null;
    }
  }

  async sellToken(mint, rawAmount) {
    this.log(`<<< [${this.executionMode}] VENDENDO ${mint.slice(0,16)}...`, 'sell');
    if (!this.sendTransactions) {
      await sleep(this.config.paperLatencyMs);
      this.log('[paper] fill virtual de venda.', 'sim');
      this.logDecision({ mint, side: 'sell', signal: 'paper-fill', sentToChain: false, executionMode: 'paper_mainnet' });
      return `SIM_SELL_${Date.now()}`;
    }
    if (!this.enableLiveAssertion()) return null;
    try {
      const sig = await this.executeJupiterSwapLIVE(mint, WRAPPED_SOL, rawAmount, this.config.slippageBps);
      this.log(`VENDA real: ${sig.slice(0,30)}...`, 'sell');
      this.logDecision({ mint, side: 'sell', signal: 'real-exec', txSignature: sig, sentToChain: true, executionMode: 'live_mainnet' });
      return sig;
    } catch (e) { this.log(`Erro na venda real: ${e.message}`, 'error'); return null; }
  }

  enableLiveAssertion() {
    return this.sendTransactions && this.config.allowRealMode && this.config.enableLiveTrading && String(this.config.iUnderstandLiveRisk).toUpperCase() === 'YES';
  }

  // ============================================================
  //  MONITORAMENTO ON-CHAIN (dados reais)
  // ============================================================

  getTokenInfo = async (mint) => {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      if (info.value?.data?.parsed) return info.value.data.parsed.info;
    } catch (e) {}
    return null;
  };

isNewPumpToken = async (signature) => {
    const ok = (t) => t && t.uiTokenAmount && Number(t.uiTokenAmount.uiAmount) > 0;
    try {
      const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) return null;
      const pre = new Set((tx.meta.preTokenBalances || [])
        .filter(t => t.mint !== WRAPPED_SOL)
        .map(t => t.mint));
      const post = (tx.meta.postTokenBalances || []).filter(t => t.mint !== WRAPPED_SOL);
      if (!post.length) return null;
      // 1) PRIORIDADE: mint que aparece AGORA mas não existia antes => launch novo
      for (const b of post) {
        if (!pre.has(b.mint) && ok(b)) return b.mint;
      }
      // 2) fallback: token ativo na tx (válido para simulação/paper)
      const active = post.find(ok);
      return active ? active.mint : null;
    } catch (e) {}
    return null;
  };

  startTokenMonitor(handler) {
    const pidStr = this.config.pumpFunProgram;
    this.log('Iniciando monitoramento on-chain da Pump.fun (polling)...', 'sniper');
    this.log(`Program: ${pidStr} | RPC: ${this.rpcUrl()}`, 'info');

    let lastSig = null;
    const seen = new Set();
    const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));

    const poll = async () => {
      if (!this.running) { this.wsConnected = false; this.emitStatus(); return; }
      try {
        const pid = new PublicKey(pidStr);
        const sigs = (await this.connection.getSignaturesForAddress(pid, { limit: 5 })).map(s => s.signature);
        if (sigs[0]) this.wsConnected = true;
        for (const sig of sigs) {
          if (seen.has(sig)) continue;
          seen.add(sig);
          try {
            const mint = await this.isNewPumpToken(sig);
            if (mint && !this.monitoredTokens.has(mint)) {
              this.log(`🎯 TOKEN DETECTADO: ${mint}`, 'sniper');
              this.logDecision({ mint, side: 'entry', signal: 'onchain-detect', mint });
              await handler?.(mint);
              await sleep2(500);
            }
          } catch (e) {}
          await sleep2(250);
        }
        this.emitStatus();
      } catch (e) {
        this.log(`Erro no polling: ${e.message}`, 'error');
      }
    };

    this.monitorHandle = setInterval(poll, this.config.monitorIntervalMs);
    this.wsConnected = false;
  }

  // ============================================================
  //  ROTEADOR DE START
  // ============================================================

  async start(options = {}) {
    if (this.running) { this.log('Bot já rodando.', 'warn'); return; }
    if (!this.wallet.publicKey) { this.log('Conecte a carteira primeiro.', 'error'); return; }

    // Modo de execução é DECIDIDO pelo backend no momento do start.
    // - simulator → sendTransactions=false (nunca assina/envia)
    // - real      → exigido validações completas; sendTransactions=true
    const mode = options.mode || 'simulator'; // default seguro
    const sim = mode === 'simulator';

    if (sim) {
      this.sendTransactions = false;
      this.executionMode = 'paper_mainnet';
      this.config.mode = 'paper_mainnet';
    } else {
      // Modo real
      this.sendTransactions = true;
      this.executionMode = 'live_mainnet';
      this.config.mode = 'live_mainnet';
    }

    // Defesa em profundidade: trata de travar REAL se qualquer flag falhar
    if (this.sendTransactions) {
      try {
        this.assertSafeMode();
      } catch (e) {
        this.log(`❌ Bloqueado: ${e.message}`, 'error');
        this.config.mode = 'paper_mainnet';
        this.executionMode = 'paper_mainnet';
        this.sendTransactions = false;
        this.emitStatus();
        return;
      }
    }

    // Conecta à rede (dados reais p/ ambos os modos)
    if (!this.connection) {
      try { await this.connect(); } catch (e) { this.log(`Falha ao conectar: ${e.message}`, 'error'); return; }
    }

    // Validações de RPC + programa Pump.fun (dados reais exigem isso)
    try {
      await this.validateRpc();
      await this.validatePumpProgram();
      this.log(`Validações OK — PROVADOR: ${this.config.pumpFunProgram}`, 'success');
    } catch (e) {
      this.log(`❌ Bloqueado na validação: ${e.message}`, 'error');
      return;
    }

    this.running = true;
    this.setState('searching');

    if (this.executionMode === 'paper_mainnet') {
      this.paperCash = this.config.paperInitialSol;
      this.equity = 0;
      this.log('⚠️  MODO SIMULADOR (paper_mainnet): lê dados REAIS, mas NENHUM transação será enviada.', 'warn');
      this.log(`Caixa virtual: ${this.paperCash} SOL | fee=${this.config.paperFeeBps}bps slip=${this.config.paperSlippageBps}bps lat=${this.config.paperLatencyMs}ms`, 'info');
    } else {
      this.log('🚨 MODO REAL (live_mainnet): transações REAIS serão enviadas à mainnet.', 'warn');
      this.log(`Carteira de execução: ${this.wallet.publicKey}`, 'info');
    }

    // Monitoramento on-chain em (dados reais served em ambos os modos)
    this.startTokenMonitor((mint) => this.onNewToken(mint));
    this.log(`Sniper iniciado | Execução: ${this.executionMode} | EnviaTx: ${this.sendTransactions}`, 'info');
    this.emitStatus();
  }

  async onNewToken(mint) {
    const balance = !this.sendTransactions ? this.paperCash : this.wallet.balanceSOL;
    if (balance < this.config.buyAmountSol + 0.01) {
      this.log(`Saldo insuficiente: ${balance.toFixed(4)} SOL`, 'error');
      return;
    }
    const sig = await this.buyToken(mint, this.config.buyAmountSol);
    if (sig) {
      this.monitoredTokens.set(mint, { amount: this.config.buyAmountSol, createdAt: Date.now(), buySignature: sig, buyTime: Date.now() });
      if (!this.sendTransactions) this.paperCash -= this.config.buyAmountSol;
      this.emitStatus();
      this.monitorToken(mint);
    }
  }

  // ============================================================
  //  MONITORAMENTO DE POSIÇÃO + P&L
  // ============================================================

  monitorToken(mint) {
    const data = this.monitoredTokens.get(mint);
    if (!data) return;
    this.log(`Monitorando ${mint.slice(0,16)}...`, 'info');
    const interval = setInterval(async () => {
      if (!this.running || !this.monitoredTokens.has(mint)) { clearInterval(interval); return; }
      try {
        const q = await axios.get(`${JUPITER_QUOTE_API}?inputMint=${mint}&outputMint=${WRAPPED_SOL}&amount=1000000&slippageBps=1000`, { timeout: 5000 });
        if (q.data?.outAmount) {
          const outSOL = parseInt(q.data.outAmount) / LAMPORTS_PER_SOL;
          const pnlPct = ((outSOL - this.config.buyAmountSol * 0.1) / (this.config.buyAmountSol * 0.1)) * 100;
          this.log(`Pnl: ${mnat(mint)} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, 'info');
          if (pnlPct >= this.config.sellTriggerPct) {
            this.log(`🚀 TAKE PROFIT (+${this.config.sellTriggerPct}%)!`, 'sell');
            clearInterval(interval);
            await this.sellAll(mint);
            this.recordTrade(mint, pnlPct, (this.config.buyAmountSol * pnlPct) / 100, 'take-profit');
            this.pnlAdjustCash(pnlPct);
            return;
          }
          if (pnlPct <= -this.config.stopLossPct) {
            this.log(`⛔ STOP LOSS (-${this.config.stopLossPct}%)!`, 'sell');
            clearInterval(interval);
            await this.sellAll(mint);
            this.recordTrade(mint, pnlPct, (this.config.buyAmountSol * pnlPct) / 100, 'stop-loss');
            this.pnlAdjustCash(pnlPct);
            return;
          }
          if (this.config.autoSellOnBuy) {
            const buys = await this.detectRecentBuys(mint);
            if (buys > 0) {
              this.log(`👀 ${buys} compra(s) por outros!`, 'sell');
              clearInterval(interval);
              await this.sellAll(mint);
              this.recordTrade(mint, pnlPct, (this.config.buyAmountSol * pnlPct) / 100, 'auto-sell');
              this.pnlAdjustCash(pnlPct);
              return;
            }
          }
        }
      } catch (e) {}
    }, this.config.monitorIntervalMs);

    setTimeout(async () => {
      if (this.monitoredTokens.has(mint)) {
        this.log(`⏰ Timeout 5min. Vendendo.`, 'sell');
        clearInterval(interval);
        await this.sellAll(mint);
        this.recordTrade(mint, 0, 0, 'timeout');
      }
    }, 5 * 60 * 1000);
  }

  pnlAdjustCash(pnlPct) {
    if (!this.sendTransactions) {
      this.paperCash += (this.config.buyAmountSol * pnlPct) / 100;
    }
  }

  async detectRecentBuys(mint) {
    try {
      const sigs = await this.connection.getSignaturesForAddress(new PublicKey(mint), { limit: 5 });
      const now = Date.now() / 1000;
      return sigs.filter(s => s.blockTime && (now - s.blockTime) < 30 && s.signature !== this.monitoredTokens.get(mint)?.buySignature).length;
    } catch (e) { return 0; }
  }

  async sellAll(mint) {
    const data = this.monitoredTokens.get(mint);
    if (!data) return;
    if (!this.sendTransactions) {
      this.monitoredTokens.delete(mint);
      this.log('[paper] fill virtual de venda.', 'sim');
      return;
    }
    if (!this.keypair) { this.log('Modo somente leitura — não é possível vender.', 'warn'); this.monitoredTokens.delete(mint); return; }
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new PublicKey(mint) });
      if (!accounts.value.length) { this.log(`Sem saldo de ${mint.slice(0,12)}...`, 'warn'); this.monitoredTokens.delete(mint); return; }
      const ta = accounts.value[0].account.data.parsed.info.tokenAmount;
      const sig = await this.sellToken(mint, ta.amount);
      if (sig) { this.monitoredTokens.delete(mint); this.log(`✅ ${mint.slice(0,12)}... vendido`, 'sell'); }
    } catch (e) { this.log(`Erro ao vender ${mint.slice(0,12)}: ${e.message}`, 'error'); }
  }

  // ============================================================
  //  MODO MOCK = lógica interna, dados fakes
  // ============================================================
  async _mockLoop() {
    this.running = true;
    this.setState('searching');
    this.log('MODO MOCK: dados locais/fakes, sem rede real.', 'sim');
    const mock = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'];
    if (this.equity === 0) this.equity = this.wallet.balanceSOL || this.config.paperInitialSol;
    while (this.running) {
      const mint = mock[Math.floor(Math.random() * mock.length)];
      this.log(`[MOCK] Novo par ${mint.slice(0,12)}...`, 'sniper');
      const pnlPct = Math.random() * 30 - 10;
      const pnlSOL = (this.config.buyAmountSol * pnlPct) / 100;
      this.log(`[MOCK] Fechando ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, pnlPct >= 0 ? 'buy' : 'sell');
      this.logDecision({ mint, side: 'both', signal: 'mock', price: 1, expectedOut: pnlSOL, simulatedOut: pnlSOL, feeBps: 0, slippageBps: 0, latencyMs: 0 });
      this.recordTrade(mint, pnlPct, pnlSOL, pnlPct >= 0 ? 'take-profit' : 'stop-loss');
      this.setState('trading'); await sleep(500); this.setState('searching');
      await sleep(1500);
    }
    this.setState('idle');
  }

  stop() {
    this.running = false;
    this.setState('idle');
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.monitorHandle) { clearInterval(this.monitorHandle); this.monitorHandle = null; }
    this.wsConnected = false;
    this.log('Bot parado.', 'warn');
    this.emitStatus();
  }

  uid() { return Math.random().toString(36).slice(2, 10); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mnat = (m) => m.slice(0, 12) + '...';
export { DEFAULTS, MODES, UPGRADEABLE_LOADER };