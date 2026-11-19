import { expect, test } from 'vitest';
import { fmtDate, fmtInterval } from './api';

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

const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

test('fmtInterval keeps short scales exact', () => {
  expect(fmtInterval(null)).toBe('');
  expect(fmtInterval(undefined)).toBe('');
  expect(fmtInterval('not-a-date')).toBe('');
  expect(fmtInterval(inFuture(10 * 60000))).toBe('10m');
  expect(fmtInterval(inFuture(3 * 3600000))).toBe('3h');
  expect(fmtInterval(inFuture(23 * 86400000))).toBe('23d');
});

test('fmtInterval distinguishes nearby month-scale dues', () => {
  // 39d vs 47d floored to the same "1mo" before; now they differ.
  expect(fmtInterval(inFuture(39 * 86400000))).toBe('1.3mo');
  expect(fmtInterval(inFuture(47 * 86400000))).toBe('1.5mo');
  // Whole months stay terse, and 30d never renders as "0mo".
  expect(fmtInterval(inFuture(30 * 86400000))).toBe('1mo');
  expect(fmtInterval(inFuture(60 * 86400000))).toBe('2mo');
});
