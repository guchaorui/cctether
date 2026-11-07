// Logging to stderr. Never log keys, proofs or connection codes.
export function createLogger(prefix = 'cctether') {
  return (msg) => process.stderr.write(`${new Date().toISOString()} ${prefix}: ${msg}\n`);
}
