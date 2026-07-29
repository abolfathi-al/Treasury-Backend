export function canonicalizeJson(value: unknown): string {
  const ancestors = new Set<object>();

  const write = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('INVALID_JSON');
      return JSON.stringify(current);
    }
    if (typeof current === 'string') {
      assertUnicodeScalarValue(current);
      return JSON.stringify(current);
    }
    if (!current || typeof current !== 'object') throw new TypeError('INVALID_JSON');
    if (ancestors.has(current)) throw new TypeError('INVALID_JSON');

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.keys(current).length !== current.length) throw new TypeError('INVALID_JSON');
        return `[${Array.from(current, write).join(',')}]`;
      }
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
        throw new TypeError('INVALID_JSON');
      }
      return `{${Object.keys(current)
        .sort()
        .map((key) => {
          assertUnicodeScalarValue(key);
          return `${JSON.stringify(key)}:${write((current as Record<string, unknown>)[key])}`;
        })
        .join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return write(value);
}

function assertUnicodeScalarValue(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('INVALID_JSON');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('INVALID_JSON');
    }
  }
}
