import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks') return body({ decks: [] });
      if (u === '/api/stats')
        return body({
          totals: { cards: 10, new: 3, learning: 1, review: 5, suspended: 1, due: 2 },
          today: { studied: 4, new: 1, reviews: 5, accuracy: 80.0 },
          forecast: [{ date: '2026-11-08', due: 2 }],
        });
      throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
    }),
  );
}

test('drawer navigates to Stats view showing fetched numbers', async () => {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  await waitFor(() => expect(screen.getByText('Stats')).toBeTruthy());
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByText('Due forecast')).toBeTruthy());
  expect(screen.getByText('80%')).toBeTruthy();
  expect(screen.getByText('New cards left')).toBeTruthy();
  vi.unstubAllGlobals();
});

test('drawer navigates to Import view', async () => {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  await waitFor(() => expect(screen.getAllByText('Import')[0]).toBeTruthy());
  fireEvent.click(screen.getAllByText('Import')[0]);
  await waitFor(() =>
    expect(screen.getByText('Choose .apkg / .colpkg file')).toBeTruthy(),
  );
  vi.unstubAllGlobals();
});
