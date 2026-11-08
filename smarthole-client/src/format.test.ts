import { expect, test } from 'vitest';
import { fmtDate } from './api';

test("fmtDate uses 12-Nov'26 style", () => {
  expect(fmtDate(null)).toBe('—');
  expect(fmtDate(undefined)).toBe('—');
  expect(fmtDate('not-a-date')).toBe('—');
  expect(fmtDate('2026-11-12T00:00:00+00:00')).toBe("12-Nov'26");
  expect(fmtDate('2026-01-05T15:30:00+00:00')).toBe("5-Jan'26");
});

test('fmtDate keeps date-only days off the timezone shift', () => {
  expect(fmtDate('2026-11-08')).toBe("8-Nov'26");
});
