import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../../src/auth/apiKey.js';

describe('API keys', () => {
  it('are mk_ + 43 base64url chars (32 random bytes)', () => {
    expect(generateApiKey()).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
  });

  it('are different every time', () => {
    const keys = new Set(Array.from({ length: 100 }, generateApiKey));
    expect(keys.size).toBe(100);
  });

  it('hash to a stable 64-char SHA-256 hex', () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()));
  });
});
