import { Connection, PublicKey } from '@solana/web3.js';
import 'dotenv/config';

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

function fail(msg) {
  console.error(`\nâŒ VALIDAÃ‡ÃƒO FALHOU: ${msg}`);
  process.exit(1);
}

(() => {
  const rpc = process.env.MAINNET_RPC_URL;
  const pidStr = process.env.PUMP_FUN_PROGRAM || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

  if (!rpc) {
    fail('MAINNET_RPC_URL nÃ£o definido. Adicione um endpoint mainnet no .env.');
  }
  console.log(`\nValidando Pump.fun program no mainnet`);
  console.log(`RPC: ${rpc}`);
  console.log(`PUMP_FUN_PROGRAM: ${pidStr}\n`);

  let pid;
  try { pid = new PublicKey(pidStr); }
  catch (e) { fail(`PUMP_FUN_PROGRAM nÃ£o Ã© um PublicKey vÃ¡lido: ${pidStr}`); }

  const conn = new Connection(rpc, 'confirmed');

  conn.getSlot()
    .then((slot) => {
      console.log(`âœ” RPC responsivo â€” slot ${slot}`);
      return conn.getAccountInfo(pid);
    })
    .then((info) => {
      if (!info) fail(`Programa nÃ£o existe nesta rede: ${pidStr}`);
      console.log(`âœ” Conta encontrada â€” executable=${info.executable} dataLen=${info.data.length}`);
      console.log(`  Owner: ${info.owner.toBase58()}`);
      if (!info.executable) fail(`A conta do programa NÃƒO Ã© executable.`);
      if (info.owner.toBase58() !== UPGRADEABLE_LOADER) {
        console.warn(`âš ï¸  Owner inesperado (nÃ£o Ã© BPFLoaderUpgradeable). Verifique se este Ã© o program da Pump.fun na rede.`);
      }
      console.log('\nâœ” PUMP_FUN_PROGRAM vÃ¡lido e carregado no mainnet.\n');
      process.exit(0);
    })
    .catch((e) => fail(e.message));
})();
