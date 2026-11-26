// Runs `cctether mcp` (the shim) for shim.test.js: argv = config dir, note grace in ms.
// It is given a stand-in for the CLI, so it can never start a real service.
import { fileURLToPath } from 'node:url';
import { runShim } from '../../src/shim.js';

const [dir, graceMs] = process.argv.slice(2);
await runShim({ dir, version: '9.9.9', cliPath: fileURLToPath(new URL('./noop.js', import.meta.url)), noteGraceMs: Number(graceMs) });
