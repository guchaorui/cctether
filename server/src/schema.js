// Validates tool arguments against the JSON Schema subset used in tools.js.
// Returns null when valid, otherwise a short English message.

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};

function matchesType(v, type) {
  const t = typeOf(v);
  return t === type || (type === 'number' && t === 'integer');
}

export function validate(schema, value, path = 'arguments') {
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some((t) => matchesType(value, t))) {
    return `${path} must be ${types.join(' or ')}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} must be a finite number`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long (max ${schema.maxLength})`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has the wrong format`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items (max ${schema.maxItems})`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validate(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) {
      if (!(k in value)) return `${path}.${k} is required`;
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        const err = validate(props[k], v, `${path}.${k}`);
        if (err) return err;
      } else if (schema.additionalProperties === false) {
        return `${path}.${k} is not a known argument (known: ${Object.keys(props).join(', ') || 'none'})`;
      }
    }
  }
  return null;
}
