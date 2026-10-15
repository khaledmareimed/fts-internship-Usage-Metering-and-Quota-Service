import { describe, expect, it } from 'vitest';
import { monthParam } from '../../src/lib/month.js';

describe('monthParam', () => {
  it('turns YYYY-MM into the first day of the month', () => {
    expect(monthParam.parse('2026-10')).toBe('2026-10-01');
    expect(monthParam.parse('2026-01')).toBe('2026-01-01');
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', 'abc', ''])('rejects %j', (value) => {
    expect(monthParam.safeParse(value).success).toBe(false);
  });
});
