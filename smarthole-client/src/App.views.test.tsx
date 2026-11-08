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
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next')) return body({ cards: [] });
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

test('review view shows the due-today count', async () => {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByText('5 due today')).toBeTruthy());
  vi.unstubAllGlobals();
});

test('review view shows the AI review button when a card is due', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next'))
        return body({
          cards: [
            {
              card_id: 'c1',
              deck_id: 'd1',
              front_html: 'Q',
              back_html: 'A',
              due: '2026-11-08',
              state: 2,
              reps: 1,
            },
          ],
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'AI review' })).toBeTruthy(),
  );
  vi.unstubAllGlobals();
});

test('browse shows a divider between due-today and later cards', async () => {
  const row = (id: string, front: string, due_today: boolean) => ({
    card_id: id,
    front_text: front,
    due: '2026-11-08',
    last_review: null,
    state: 2,
    reps: 1,
    suspended: false,
    due_today,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next')) return body({ cards: [] });
      if (u.startsWith('/api/decks/d1/cards'))
        return body({
          cards: [row('c1', 'Due Q', true), row('c2', 'Later Q', false)],
          total: 2,
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByTestId('due-divider')).toBeTruthy());
  vi.unstubAllGlobals();
});

test('grade buttons show the interval until next review', async () => {
  const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next'))
        return body({
          cards: [
            {
              card_id: 'c1',
              deck_id: 'd1',
              front_html: 'Q',
              back_html: 'A',
              due: '2026-11-08',
              state: 2,
              reps: 1,
              intervals: {
                '1': inFuture(10 * 60000),
                '2': inFuture(3 * 3600000),
                '3': inFuture(23 * 86400000),
                '4': inFuture(60 * 86400000),
              },
            },
          ],
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Show answer' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
  await waitFor(() => expect(screen.getByText('23d')).toBeTruthy());
  expect(screen.getByText('10m')).toBeTruthy();
  vi.unstubAllGlobals();
});

test('review preloads the next card excluding the current one', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
      });
    if (u.startsWith('/api/next'))
      return body({
        cards: [
          {
            card_id: 'c1',
            deck_id: 'd1',
            front_html: 'Q',
            back_html: 'A',
            due: '2026-11-08',
            state: 2,
            reps: 1,
          },
        ],
      });
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('exclude=c1')),
    ).toBe(true),
  );
  vi.unstubAllGlobals();
});

test('browse search filters loaded rows then queries the database', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u.startsWith('/api/decks/d1/cards')) {
      const all = [
        {
          card_id: 'c1',
          front_text: 'Due Q',
          due: '2026-11-08',
          last_review: null,
          state: 2,
          reps: 1,
          suspended: false,
          due_today: true,
        },
        {
          card_id: 'c2',
          front_text: 'Later Q',
          due: '2026-12-08',
          last_review: null,
          state: 2,
          reps: 1,
          suspended: false,
          due_today: false,
        },
      ];
      const m = /[?&]q=([^&]*)/.exec(u);
      const needle = m ? decodeURIComponent(m[1]).toLowerCase() : '';
      const cards = needle
        ? all.filter((c) => c.front_text.toLowerCase().includes(needle))
        : all;
      return body({ cards, total: cards.length });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Due Q')).toBeTruthy());
  // Typing filters the already-loaded rows instantly…
  fireEvent.change(screen.getByLabelText('Search cards'), {
    target: { value: 'Later' },
  });
  expect(screen.queryByText('Due Q')).toBeNull();
  expect(screen.getByText('Later Q')).toBeTruthy();
  // …then the debounced database search commits.
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('q=Later')),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.queryByText('Due Q')).toBeNull());
  expect(screen.getByText('Later Q')).toBeTruthy();
  vi.unstubAllGlobals();
});

test('review edit flow updates the card', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next'))
        return body({
          cards: [
            {
              card_id: 'c1',
              deck_id: 'd1',
              front_html: 'Q',
              back_html: 'A',
              due: '2026-11-08',
              state: 2,
              reps: 1,
            },
          ],
        });
      if (u === '/api/cards/c1' && init?.method === 'PUT')
        return body({
          card_id: 'c1',
          deck_id: 'd1',
          front_html: 'Q',
          back_html: 'A2',
        });
      throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Question')).toHaveValue('Q');
  fireEvent.change(screen.getByLabelText('Answer'), {
    target: { value: 'A2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByLabelText('Question')).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
  await waitFor(() => expect(screen.getByText('A2')).toBeTruthy());
  vi.unstubAllGlobals();
});

test('AI review dialog reports when no change is needed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next'))
        return body({
          cards: [
            {
              card_id: 'c1',
              deck_id: 'd1',
              front_html: 'Q',
              back_html: 'A',
              due: '2026-11-08',
              state: 2,
              reps: 1,
            },
          ],
        });
      if (u === '/api/cards/c1/ai-review' && init?.method === 'POST')
        return body({ suggestions: [], model: 'muse-spark-1.3-contributor' });
      throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'AI review' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'AI review' }));
  await waitFor(() =>
    expect(screen.getByText(/No changes suggested/)).toBeTruthy(),
  );
  expect(screen.getByText(/took \d+\.\ds/)).toBeTruthy();
  vi.unstubAllGlobals();
});

test('import shows streamed progress then the result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks') return body({ decks: [] });
      if (u.startsWith('/api/next')) return body({ cards: [] });
      if (u.startsWith('/api/import')) {
        const enc = new TextEncoder();
        const tail =
          '{"stage":"save","done":2,"total":2}\n' +
          '{"complete":true,"result":{"imported":2,"decks":1,"scheduling":true,"due":2}}\n';
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('{"stage":"parse","done":1,"total":2}\n'));
            setTimeout(() => {
              c.enqueue(enc.encode(tail));
              c.close();
            }, 50);
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  const { container } = render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  await waitFor(() => expect(screen.getAllByText('Import')[0]).toBeTruthy());
  fireEvent.click(screen.getAllByText('Import')[0]);
  await waitFor(() =>
    expect(screen.getByText('Choose .apkg / .colpkg file')).toBeTruthy(),
  );
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  expect(input).toBeTruthy();
  fireEvent.change(input!, {
    target: { files: [new File(['x'], 'test.apkg', { type: 'application/zip' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  await waitFor(() =>
    expect(screen.getByText(/Reading cards — 1 of 2 cards/)).toBeTruthy(),
  );
  await waitFor(() =>
    expect(screen.getByText(/2 cards imported, 2 due now/)).toBeTruthy(),
  );
  vi.unstubAllGlobals();
});
