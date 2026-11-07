#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => { if (typeof code === 'number') process.exitCode = code; },
  (e) => { process.stderr.write(`cctether: ${e.stack ?? e.message}\n`); process.exitCode = 1; },
);
