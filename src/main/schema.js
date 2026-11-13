'use strict';
// Minimal JSON Schema check for action inputs (object / string / number / integer / boolean /
// array, properties, required, enum, items, additionalProperties: false). Action inputs come
// from two untrusted places - the renderer and the AI model - so every one is checked here
// before its handler runs. Returns an error string, or null when the value is valid.

function validate(schema, value, path = 'input') {
  const types = [].concat(schema.type || []);
  if (types.length && !types.some((t) => isType(t, value))) {
    return `${path} must be ${types.join(' or ')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const e = validate(schema.items, value[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (isType('object', value)) {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (!props[key]) {
        if (schema.additionalProperties === false) return `${path}.${key} is not a known field`;
        continue;
      }
      const e = validate(props[key], v, `${path}.${key}`);
      if (e) return e;
    }
  }
  return null;
}

function isType(type, v) {
  switch (type) {
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return false;
  }
}

module.exports = { validate };
