# SniperAI — Dashboard do Bot

Interface web para **conectar carteira Solana** (Phantom / Solflare / chave local) e **configurar e controlar** um bot sniper da Pump.fun. Inclui backend Node (Express + WebSocket) que executa o bot, monitora a blockchain on-chain via WebSocket RPC e executa swaps pela **API oficial do Jupiter**.

## Funcionalidades

- **Conectar carteira**: Phantom / Solflare (modo leitura via `window.solana`) ou chave privada (base58/JSON array) usada no processo Node local.
- **Configuração em tempo real** de trading (valor de compra, take profit, stop loss, slippage, bonding curve, fee, auto-sell on buy).
- **Monitoração on-chain** do programa Pump.fun via `logsSubscribe`, detectando novos tokens e comprando automaticamente.
- **Swaps seguros** pela API oficial do Jupiter (assinatura local — a chave nunca sai do seu PC).
- **Venda inteligente**: take profit, stop loss e auto-sell ao detectar compras de outros.
- **Logs e status em tempo real** via WebSocket.

## Estrutura

```
bot-dashboard/
├── server.js             # Express + WebSocket (REST API + estáticos)
├── src/bot.js            # Classe SniperBot (on-chain + Jupiter)
├── public/               # Frontend (index.html, css, js)
├── .env.example
└── package.json
```

## Instalação

```bash
cd bot-dashboard
npm install
cp .env.example .env   # ajuste se necessário
npm start
```

Abra <http://localhost:4178>.

## Modos de execução (`AGENT_MODE`)

O agente **nunca envia transações reais** a menos que todos os modos de segurança abaixo estejam explícitos.
Escolha o modo via env `AGENT_MODE` no `.env` ou pelos scripts npm:

| Modo | Env | O que faz | Envia transação? |
|---|---|---|---|
| **mock** | `mock` | Dados locais/fake, loop de simulação. | ❌ Não |
| **paper_mainnet** *(padrão)* | `paper_mainnet` | Lê dados **reais** do mainnet (monitora Pump.fun), decide e registra fills **virtuais**. | ❌ Não |
| **simulate_rpc** | `simulate_rpc` | Monta a transação Jupiter real e roda `simulateTransaction` (não a envia). | ❌ Não (apenas simula) |
| **live_mainnet** | `live_mainnet` | Envia swaps **reais** na blockchain. | ✅ Sim — **custa SOL** |

```bash
npm run mock        # AGENT_MODE=mock
npm run paper       # AGENT_MODE=paper_mainnet
npm run simulate    # AGENT_MODE=simulate_rpc
npm run live        # AGENT_MODE=live_mainnet
npm run validate    # valida RPC mainnet + programa Pump.fun
```

### LIVE só com confirmação explícita
Para que `live_mainnet` **envie** transações, **todos** precisam estar assim:

```
AGENT_MODE=live_mainnet
ALLOW_REAL_MODE=true
ENABLE_LIVE_TRADING=true
I_UNDERSTAND_LIVE_RISK=YES
```

Além disso, o botão **Real** exige que você digite `REAL` no modal de confirmação. Caso contrário o bot **nega** a transação e loga o motivo. Em `mock`/`paper_mainnet`/`simulate_rpc` a chave privada nunca é usada para assinar/envio.

### Os dois botões (backend não confia no switch)
- **Simulado** → atende `{ mode: "simulator" }` → `executionMode=paper_mainnet`, `sendTransactions=false`. É **impossível** assinar ou enviar (`sendTransaction` nunca é chamado). Lê dados reais, simula fills.
- **REAL** → atende `{ mode: "real", confirmation: "REAL" }` **somente** se todas as travas de env acima + RPC/program/carteira estiverem válidas → `executionMode=live_mainnet`, `sendTransactions=true`.
- Toda ordem registrada carrega `sentToChain` e `executionMode`.

### Validação de rede e programa
Antes de iniciar em modos mainnet, o bot valida:
- **MAINNET_RPC_URL** — responde (`getHealth`/`getSlot`).
- **PUMP_FUN_PROGRAM** — conta existe, é `executable` e owner `BPFLoaderUpgradeable`.

Rode `npm run validate` para um check único, ou `POST /api/validate`.

## Segurança

- A chave privada é usada **apenas no processo Node local** e nunca é transmitida a terceiros.
- Se falhar `MAINNET_RPC_URL` ou o programa não validar, o bot **não opera** em modo real (inicia mock se permitido, ou encerra).
- Use carteiras de **teste/devnet**. Nunca use a carteira principal em LIVE.
- SSL/TLS permanece ativo nas RPCs. Prefira RPC dedicado (Helius/QuickNode) em mainnet.

## Conectar carteira

1. **Phantom/Solflare:** clique no botão da extensão (modo somente leitura).
2. **Chave local (para LIVE):** cole base58 ou array JSON `[..64]` — o Node monta o `Keypair` e assina transações localmente.

## API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/wallet/connect` | `{ secret }` ou `{ viewOnly:true, publicKey }` |
| POST | `/api/wallet/disconnect` | Limpa carteira |
| POST | `/api/wallet/refresh` | Atualiza saldo/tokens |
| GET  | `/api/config` | Retorna config atual |
| POST | `/api/config` | Atualiza config (merge) |
| POST | `/api/bot/start` | Inicia o bot (simulação ou live) |
| POST | `/api/bot/stop` | Para o bot |
| GET  | `/api/status` | Estado/status (inclui `mode` e `network`) |
| POST | `/api/validate` | Valida RPC mainnet + programa Pump.fun |

WebSocket `/ws` emite: `log`, `status`, `wallet`, `config`, `state`.

## Observação

Para uso em **mainnet real**, verifique o IDL/programa atual da Pump.fun e ajuste `PUMP_FUN_PROGRAM` e a detecção de eventos em `src/bot.js` conforme necessário. Teste sempre em devnet primeiro.