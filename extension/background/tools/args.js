// Defensive argument checks. The server validates against the JSON schemas in
// server/src/tools.js, but the extension does not trust its input blindly.

import { ToolError } from './errors.js';

const bad = (msg) => new ToolError('bad_args', msg);

export const int = (min, max) => (v, k) => {
  if (!Number.isInteger(v) || (min != null && v < min) || (max != null && v > max)) {
    const range = min != null && max != null ? ` between ${min} and ${max}` : min != null ? ` ≥ ${min}` : '';
    throw bad(`\`${k}\` must be an integer${range}.`);
  }
};

export const num = () => (v, k) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`\`${k}\` must be a number.`);
};

export const bool = () => (v, k) => {
  if (typeof v !== 'boolean') throw bad(`\`${k}\` must be true or false.`);
};

export const str = (min = 0, max = 100000) => (v, k) => {
  if (typeof v !== 'string') throw bad(`\`${k}\` must be a string.`);
  if (v.length < min) throw bad(`\`${k}\` must not be empty.`);
  if (v.length > max) throw bad(`\`${k}\` is too long (at most ${max} characters).`);
};

export const oneOf = (...values) => (v, k) => {
  if (!values.includes(v)) throw bad(`\`${k}\` must be one of: ${values.map((x) => JSON.stringify(x)).join(', ')}.`);
};

export const strOrStrings = (maxItems, maxLen = 10000) => (v, k) => {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > maxItems || list.some((x) => typeof x !== 'string' || x.length > maxLen)) {
    throw bad(`\`${k}\` must be a string or an array of 1–${maxItems} strings.`);
  }
};

export const listOf = (maxItems, item) => (v, k) => {
  if (!Array.isArray(v) || v.length > maxItems) throw bad(`\`${k}\` must be an array of at most ${maxItems} items.`);
  v.forEach((x, i) => item(x, `${k}[${i}]`));
};

export const pattern = (re, hint) => (v, k) => {
  if (typeof v !== 'string' || !re.test(v)) throw bad(`\`${k}\` must be ${hint}.`);
};

/** Shared argument specs. */
export const A = {
  tab: int(0),
  ref: int(1),
  selector: str(1, 2000),
  x: num(),
  y: num(),
  timeout: (max) => int(100, max),
};

/**
 * Check `args` against `spec` ({ name: validator }). Unknown keys are rejected; null counts as
 * absent. Returns a clean copy.
 */
export function checkArgs(tool, args, spec, required = []) {
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw bad(`Arguments for ${tool} must be an object.`);
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (!Object.hasOwn(spec, k)) {
      const valid = Object.keys(spec);
      throw bad(`Unknown argument \`${k}\` for ${tool}.${valid.length ? ` Valid arguments: ${valid.join(', ')}.` : ' It takes no arguments.'}`);
    }
    if (v === null || v === undefined) continue;
    spec[k](v, k);
    out[k] = v;
  }
  for (const k of required) {
    if (out[k] === undefined) throw bad(`\`${k}\` is required for ${tool}.`);
  }
  return out;
}
