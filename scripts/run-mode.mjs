const mode = process.argv[2] || 'paper_mainnet';
process.env.AGENT_MODE = mode;
console.log(`\n▶  SniperAI iniciando em modo: ${mode}\n`);
await import('../server.js');