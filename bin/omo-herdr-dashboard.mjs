#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
if (command === '--version') console.log('0.1.0');
else if (command === '--help' || !command) console.log('omo-herdr-dashboard install [--agent-dir PATH] [--lang en|ko|zh-cn] [--dry-run]\nIn OmO inside Herdr, use /dashboard to open all four views.');
else if (command === 'install') {
  const { install } = await import('../dist/install.mjs');
  console.log(JSON.stringify(await install(args), null, 2));
} else throw new Error('Unknown command: ' + command);
