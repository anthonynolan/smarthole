import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import App from './App';
import { htmlToText } from './api';

test('htmlToText preserves block line breaks for the edit round-trip', () => {
  expect(htmlToText('Line one<br>Line two')).toBe('Line one\nLine two');
  expect(htmlToText('<p>Para one</p><p>Para two</p>')).toBe('Para one\nPara two');
  expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb');
  expect(htmlToText('Q<hr>A')).toBe('Q\nA');
});

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
      if (u.startsWith('/api/next')) return body({ cards: [], next_due_at: null });
      if (u === '/api/today') return body({ studied: 4 });
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
  await waitFor(() => expect(screen.getAllByText('Import/Export')[0]).toBeTruthy());
  fireEvent.click(screen.getAllByText('Import/Export')[0]);
  await waitFor(() =>
    expect(screen.getByText('Choose .apkg / .colpkg file')).toBeTruthy(),
  );
  vi.unstubAllGlobals();
});

test('review view shows the due-today count', async () => {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByText(/5 due today/)).toBeTruthy());
  await waitFor(() => expect(screen.getByText(/4 studied today/)).toBeTruthy());
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

test('browse shows created date and suspended flag columns', async () => {
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
          cards: [
            {
              card_id: 'c1',
              card_number: 7,
              front_text: 'Suspended Q',
              due: '2026-11-08',
              last_review: null,
              created_at: '2026-10-01T00:00:00+00:00',
              state: 2,
              reps: 1,
              suspended: true,
              due_today: false,
            },
          ],
          total: 1,
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Suspended Q')).toBeTruthy());
  expect(screen.getByText('Created')).toBeTruthy();
  expect(screen.getByText('Susp.')).toBeTruthy();
  expect(screen.getByText('7')).toBeTruthy();
  expect(screen.getByText("1-Oct'26")).toBeTruthy();
  expect(screen.getByText('Yes')).toBeTruthy();
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

function ndjsonResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const line of lines) c.enqueue(enc.encode(line + '\n'));
      c.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

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
      if (u.startsWith('/api/cards/c1/ai-review/stream'))
        return ndjsonResponse([
          JSON.stringify({ delta: '{"cards": []}' }),
          JSON.stringify({ done: true, suggestions: [], model: 'm' }),
        ]);
      throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'AI review' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'AI review' }));
  // Options come first: split is offered; the question box only appears
  // for the ask-a-question option.
  await waitFor(() => expect(screen.getByText('Split this card')).toBeTruthy());
  expect(screen.queryByLabelText('Your question')).toBeNull();
  fireEvent.click(screen.getByText('Ask a question about this card'));
  await waitFor(() => expect(screen.getByLabelText('Your question')).toBeTruthy());
  fireEvent.click(screen.getByText('Split this card'));
  await waitFor(() => expect(screen.queryByLabelText('Your question')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
  await waitFor(() =>
    expect(screen.getByText(/No changes suggested/)).toBeTruthy(),
  );
  expect(screen.getByText(/took \d+\.\ds/)).toBeTruthy();
  // The chosen option stays visible and the model is shown.
  expect(screen.getByTestId('ai-selection')).toHaveTextContent('Split this card');
  expect(screen.getByTestId('ai-model')).toHaveTextContent('Model: m');
  expect(screen.getByTestId('ai-status')).toHaveTextContent('finished');
  vi.unstubAllGlobals();
});

test('AI review streams the output as it arrives', async () => {
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
      if (u.startsWith('/api/cards/c1/ai-review/stream')) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify({ delta: '{"cards":' }) + '\n'));
            setTimeout(() => {
              c.enqueue(
                enc.encode(
                  JSON.stringify({ delta: ' []}' }) +
                    '\n' +
                    JSON.stringify({ done: true, suggestions: [], model: 'm' }) +
                    '\n',
                ),
              );
              c.close();
            }, 50);
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'AI review' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'AI review' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Ask AI' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
  // While streaming, only a progress indicator shows (no raw JSON dump).
  await waitFor(() =>
    expect(screen.getByLabelText('loading AI suggestions')).toBeTruthy(),
  );
  expect(screen.queryByTestId('ai-stream')).toBeNull();
  await waitFor(() =>
    expect(screen.getByText(/No changes suggested/)).toBeTruthy(),
  );
  vi.unstubAllGlobals();
});

test('AI review answers a custom question about the card', async () => {
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
    if (u.startsWith('/api/cards/c1/ai-review/stream'))
      return ndjsonResponse([
        JSON.stringify({ delta: 'Yes, still valid.' }),
        JSON.stringify({ done: true, answer: 'Yes, still valid.', model: 'm' }),
      ]);
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'AI review' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'AI review' }));
  await waitFor(() =>
    expect(screen.getByText('Ask a question about this card')).toBeTruthy(),
  );
  fireEvent.click(screen.getByText('Ask a question about this card'));
  fireEvent.change(screen.getByLabelText('Your question'), {
    target: { value: 'is this card still valid?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
  await waitFor(() => expect(screen.getByTestId('ai-answer')).toBeTruthy());
  expect(screen.getByTestId('ai-answer')).toHaveTextContent('Yes, still valid.');
  expect(
    fetchMock.mock.calls.some(([u]) =>
      String(u).includes('question=is%20this%20card%20still%20valid%3F'),
    ),
  ).toBe(true);
  vi.unstubAllGlobals();
});

test('review view shows the card creation date', async () => {
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
              created_at: '2026-10-01T00:00:00+00:00',
            },
          ],
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByText(/Created 1-Oct'26/)).toBeTruthy());
  vi.unstubAllGlobals();
});

test('review view deletes the card after confirmation', async () => {
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 1, due: 1, due_today: 1, new: 0 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u === '/api/cards/c1' && init?.method === 'DELETE')
      return body({ deleted: 'c1' });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  // First /api/next call returns the card; later calls return nothing.
  let nextCalls = 0;
  const counting = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('/api/next') && nextCalls++ === 0) {
      return {
        ok: true,
        json: () =>
          Promise.resolve({
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
          }),
      };
    }
    return fetchMock(url, init);
  });
  vi.stubGlobal('fetch', counting);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy(),
  );
  // Delete lives inside the edit panel: no standalone Delete button.
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.getByText('Delete this card?')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Delete card' }));
  await waitFor(() =>
    expect(
      counting.mock.calls.some(
        ([u, init]) => String(u) === '/api/cards/c1' && init?.method === 'DELETE',
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByText('Nothing due — nice work.')).toBeTruthy(),
  );
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
  await waitFor(() => expect(screen.getAllByText('Import/Export')[0]).toBeTruthy());
  fireEvent.click(screen.getAllByText('Import/Export')[0]);
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

test('edit panel shows full card metadata for troubleshooting', async () => {
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
              deck_name: 'Test',
              front_html: 'Q',
              back_html: 'A',
              due: '2026-11-08',
              state: 2,
              reps: 3,
              created_at: '2026-10-01T00:00:00+00:00',
              meta: {
                card_id: 'c1',
                deck_id: 'd1',
                deck_name: 'Test',
                created_at: '2026-10-01T00:00:00+00:00',
                suspended: false,
                deleted: false,
                deleted_at: null,
                new_position: 7,
                anki_nid: 11,
                anki_ord: 0,
                anki_guid: 'guid-1',
                due: '2026-11-08',
                last_review: '2026-11-07',
                state: 2,
                step: 0,
                stability: 5.5,
                difficulty: 4.2,
                reps: 3,
                lapses: 1,
                introduced_at: '2026-10-02T00:00:00+00:00',
              },
            },
          ],
        });
      throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
    }),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await waitFor(() => expect(screen.getByTestId('card-metadata')).toBeTruthy());
  const meta = screen.getByTestId('card-metadata');
  expect(meta).toHaveTextContent('Card ID');
  expect(meta).toHaveTextContent('guid-1');
  expect(meta).toHaveTextContent('Stability');
  expect(meta).toHaveTextContent('5.5');
  expect(meta).toHaveTextContent('Lapses');
  vi.unstubAllGlobals();
});

test('related card link queues it next after grading', async () => {
  const c1 = {
    card_id: 'c1',
    deck_id: 'd1',
    front_html: 'Q1',
    back_html: 'A1',
    due: '2026-11-08',
    state: 2,
    reps: 1,
  };
  const c2 = {
    card_id: 'c2',
    deck_id: 'd1',
    front_html: 'Q2',
    back_html: 'A2',
    due: '2026-11-08',
    state: 2,
    reps: 1,
  };
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
      });
    if (u.startsWith('/api/next')) {
      // Initial load and prefetch: only the first call has no exclude.
      if (u.includes('exclude')) return body({ cards: [] });
      return body({ cards: [c1] });
    }
    if (u.startsWith('/api/cards/c1/related'))
      return body({
        cards: [{ card_id: 'c2', front_text: 'Q2', deck_name: 'Test', score: 0.9 }],
        unavailable: false,
      });
    if (u.startsWith('/api/cards/c2/related'))
      return body({ cards: [], unavailable: true });
    if (u === '/api/cards/c2' && init?.method !== 'DELETE') return body(c2);
    if (u === '/api/review/c1' && init?.method === 'POST') return body(c1);
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  // The related hint stays hidden while only the question is shown, even
  // once its data has loaded.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show answer' })).toBeTruthy());
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/cards/c1/related')),
    ).toBe(true),
  );
  expect(screen.queryByTestId('related-hint')).toBeNull();
  // After the answer is shown, the hint shows the closest card as a title link.
  fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
  await waitFor(() => expect(screen.getByTestId('related-hint')).toBeTruthy());
  expect(screen.getByTestId('related-hint')).toHaveTextContent('Q2');
  // Clicking it queues the related card instead of navigating away.
  fireEvent.click(screen.getByText('Q2'));
  await waitFor(() => expect(screen.getByTestId('queued-next')).toBeTruthy());
  expect(screen.getByTestId('queued-next')).toHaveTextContent('Q2');
  // Grading the current card shows the queued card next (the answer is
  // already shown from revealing the hint above).
  fireEvent.click(screen.getByRole('button', { name: 'Good' }));
  await waitFor(() => expect(screen.getByText('Q2', { selector: 'div' })).toBeTruthy());
  expect(screen.queryByTestId('queued-next')).toBeNull();
  vi.unstubAllGlobals();
});

test('browse show-deleted lists only deleted cards with restore', async () => {
  const live = {
    card_id: 'c1',
    front_text: 'Live Q',
    due: '2026-11-08',
    last_review: null,
    state: 2,
    reps: 1,
    suspended: false,
    due_today: true,
  };
  const gone = {
    card_id: 'c9',
    front_text: 'Gone Q',
    due: '2026-11-08',
    last_review: null,
    state: 2,
    reps: 1,
    suspended: false,
    deleted: true,
    due_today: false,
  };
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
      const deletedOnly = u.includes('show_deleted=true');
      const cards = deletedOnly ? [gone] : [live];
      return body({ cards, total: cards.length });
    }
    if (u === '/api/cards/c9/restore' && init?.method === 'POST')
      return body({ restored: 'c9' });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Live Q')).toBeTruthy());
  expect(screen.queryByText('Gone Q')).toBeNull();
  // Toggle to deleted-only: live cards disappear, restore actions appear.
  fireEvent.click(screen.getByText('Show deleted'));
  await waitFor(() => expect(screen.getByText('Gone Q')).toBeTruthy());
  expect(screen.queryByText('Live Q')).toBeNull();
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete forever' })).toBeTruthy();
  // The due-today divider is hidden in deleted-only mode.
  expect(screen.queryByTestId('due-divider')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => String(u) === '/api/cards/c9/restore' && init?.method === 'POST',
      ),
    ).toBe(true),
  );
  vi.unstubAllGlobals();
});

test('browse row click opens the full card detail', async () => {
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
    if (u.startsWith('/api/decks/d1/cards'))
      return body({
        cards: [
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
        ],
        total: 1,
      });
    if (u === '/api/cards/c1')
      return body({
        card_id: 'c1',
        deck_id: 'd1',
        deck_name: 'Test',
        front_html: '<p>Due Q</p>',
        back_html: '<p>Full A</p>',
        due: '2026-11-08',
        state: 2,
        reps: 1,
        meta: {
          card_id: 'c1',
          deck_id: 'd1',
          deck_name: 'Test',
          suspended: false,
          deleted: false,
          new_position: 1,
          state: 2,
          step: 0,
          reps: 1,
          lapses: 0,
        },
      });
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Due Q')).toBeTruthy());
  fireEvent.click(screen.getByText('Due Q'));
  await waitFor(() => expect(screen.getByTestId('browse-detail')).toBeTruthy());
  expect(
    fetchMock.mock.calls.some(([u]) => String(u) === '/api/cards/c1'),
  ).toBe(true);
  expect(screen.getByTestId('browse-detail')).toHaveTextContent('Full A');
  expect(screen.getByTestId('browse-detail')).toHaveTextContent('Card metadata');
  vi.unstubAllGlobals();
});

test('browse detail edit updates the card', async () => {
  let savedBack = 'Full A';
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
        cards: [
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
        ],
        total: 1,
      });
    if (u === '/api/cards/c1' && init?.method === 'PUT') {
      const payload = JSON.parse(init.body);
      savedBack = payload.back;
      return body({ card_id: 'c1', deck_id: 'd1', front_html: 'Due Q', back_html: savedBack });
    }
    if (u === '/api/cards/c1')
      return body({
        card_id: 'c1',
        deck_id: 'd1',
        deck_name: 'Test',
        front_html: '<p>Due Q</p>',
        back_html: `<p>${savedBack}</p>`,
        due: '2026-11-08',
        state: 2,
        reps: 1,
        meta: null,
      });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Due Q')).toBeTruthy());
  fireEvent.click(screen.getByText('Due Q', { selector: 'td' }));
  await waitFor(() => expect(screen.getByTestId('browse-detail')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Question')).toHaveValue('Due Q');
  expect(screen.getByLabelText('Answer')).toHaveValue('Full A');
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Full A2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) =>
          String(u) === '/api/cards/c1' &&
          init?.method === 'PUT' &&
          JSON.parse(init.body).back === 'Full A2',
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByTestId('browse-detail')).toHaveTextContent('Full A2'),
  );
  vi.unstubAllGlobals();
});

test('browse starts from the last-used deck', async () => {
  localStorage.setItem('smarthole.browseDeckId', 'd1');
  try {
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [
            { id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 },
            { id: 'd2', name: 'Other', total: 1, due: 0, due_today: 0, new: 1 },
          ],
        });
      if (u.startsWith('/api/next')) return body({ cards: [] });
      if (u.startsWith('/api/decks/d1/cards'))
        return body({
          cards: [
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
          ],
          total: 1,
        });
      if (u.startsWith('/api/decks/d2/cards')) return body({ cards: [], total: 0 });
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('menu'));
    fireEvent.click(screen.getAllByText('Browse')[0]);
    await waitFor(() => expect(screen.getByText('Due Q')).toBeTruthy());
    // The remembered deck drives the first cards request, without waiting
    // for the deck list to pick it.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/decks/d1/cards')),
    ).toBe(true);
  } finally {
    localStorage.removeItem('smarthole.browseDeckId');
  }
  vi.unstubAllGlobals();
});

test('browse bulk delete removes all selected cards with one confirm', async () => {
  const row = (id: string, front: string) => ({
    card_id: id,
    front_text: front,
    due: '2026-11-08',
    last_review: null,
    state: 2,
    reps: 1,
    suspended: false,
    due_today: true,
  });
  const deleted = new Set<string>();
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
      const cards = [row('c1', 'Due Q'), row('c2', 'Later Q')].filter(
        (c) => !deleted.has(c.card_id),
      );
      return body({ cards, total: cards.length });
    }
    const del = /^\/api\/cards\/([^/]+)$/.exec(u);
    if (del && init?.method === 'DELETE') {
      deleted.add(del[1]);
      return body({ deleted: del[1], permanent: false });
    }
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('menu'));
    fireEvent.click(screen.getAllByText('Browse')[0]);
    await waitFor(() => expect(screen.getByText('Due Q')).toBeTruthy());
    expect(screen.getByText('Later Q')).toBeTruthy();
    // Selecting one row offers a bulk delete for just that card…
    fireEvent.click(screen.getByLabelText('Select card 1'));
    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
    // …while the header checkbox selects everything visible.
    fireEvent.click(screen.getByLabelText('Select all visible cards'));
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await waitFor(() => expect(screen.queryByText('Due Q')).toBeNull());
    expect(screen.queryByText('Later Q')).toBeNull();
    // One confirm for the whole batch, one DELETE per selected card.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(new Set(['c1', 'c2']));
  } finally {
    confirmSpy.mockRestore();
    vi.unstubAllGlobals();
  }
});

test('browse column headings sort the list on click', async () => {
  const row = (id: string, front: string) => ({
    card_id: id,
    front_text: front,
    due: '2026-11-08',
    last_review: null,
    created_at: '2026-10-01T00:00:00+00:00',
    state: 2,
    reps: 1,
    suspended: false,
    due_today: true,
  });
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
    if (u.startsWith('/api/decks/d1/cards'))
      return body({ cards: [row('c1', 'Q one')], total: 1 });
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Q one')).toBeTruthy());
  fireEvent.click(screen.getByText('Created'));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('sort=created_at')),
    ).toBe(true),
  );
  vi.unstubAllGlobals();
});

test('stats view shows server deploy and UI build times', async () => {
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
      if (u === '/api/stats')
        return body({
          totals: { cards: 10, new: 3, learning: 1, review: 5, suspended: 1, due: 2 },
          today: { studied: 4, new: 1, reviews: 5, accuracy: 80.0 },
          forecast: [{ date: '2026-11-08', due: 2 }],
        });
      if (u === '/api/build-info')
        return body({ server_started_at: '2026-11-12T14:05:00+00:00', server_git_sha: 'abc123' });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByTestId('due-forecast-chart')).toBeTruthy());
  expect(screen.getByTestId('build-info')).toHaveTextContent('Server deployed');
  expect(screen.getByTestId('build-info')).toHaveTextContent('UI built');
  vi.unstubAllGlobals();
});

test('feedback view submits typed feedback and lists it', async () => {
  const mine: any[] = [];
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u === '/api/feedback' && (!init?.method || init.method === 'GET'))
      return body({ feedback: [...mine] });
    if (u === '/api/feedback' && init?.method === 'POST') {
      const created = {
        id: 'f1',
        email: 't@example.com',
        username: '',
        text: JSON.parse(init.body).text,
        screen: 'Feedback',
        status: 'submitted',
        created_at: '2026-11-12T14:05:00+00:00',
      };
      mine.unshift(created);
      return { ok: true, status: 201, json: () => Promise.resolve(created) };
    }
    if (u.startsWith('/api/feedback/all'))
      return {
        ok: false,
        status: 403,
        text: () => Promise.resolve('Admin only'),
        json: () => Promise.resolve({}),
      };
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
  await waitFor(() => expect(screen.getByLabelText('Your feedback')).toBeTruthy());
  expect(screen.getByText('My feedback')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Your feedback'), {
    target: { value: 'Great app' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Great app')).toBeTruthy());
  expect(
    fetchMock.mock.calls.some(
      ([u, init]) => u === '/api/feedback' && init?.method === 'POST',
    ),
  ).toBe(true);
  vi.unstubAllGlobals();
});

test('feedback view shows everyone with usernames for the admin', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 'anthonynolan@gmail.com' });
      if (u === '/api/decks')
        return body({
          decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
        });
      if (u.startsWith('/api/next')) return body({ cards: [] });
      if (u === '/api/feedback') return body({ feedback: [] });
      if (u.startsWith('/api/feedback/all'))
        return body({
          feedback: [
            {
              id: 'f9',
              email: 'someone@example.com',
              username: 'Someone',
              text: 'Needs work',
              screen: 'Review',
              status: 'submitted',
              created_at: '2026-11-12T14:05:00+00:00',
            },
          ],
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
  await waitFor(() => expect(screen.getByText('All feedback')).toBeTruthy());
  expect(screen.getByText('Someone')).toBeTruthy();
  expect(screen.getByText('Needs work')).toBeTruthy();
  // One status filter plus one per-item status control.
  expect(screen.getAllByLabelText('Status')).toHaveLength(2);
  expect(screen.getByLabelText('Filter by user')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Export filtered list' })).toBeTruthy();
  vi.unstubAllGlobals();
});

test('admin view overwrites dev data after confirmation', async () => {
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me')
      return body({ email: 'anthonynolan@gmail.com', is_admin: true });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 10, due: 3, due_today: 5, new: 2 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (
      u === '/api/admin/overwrite-dev-from-prod' &&
      init?.method === 'POST'
    )
      return body({
        overwritten: true,
        from: 'smarthole_prod',
        to: 'smarthole_dev',
        collections: { decks: 2, cards: 5 },
        relogin_required: true,
      });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('menu'));
    fireEvent.click(screen.getByText('Admin'));
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Overwrite dev data with production data',
        }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Overwrite dev data with production data',
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Dev data replaced with production data/)).toBeTruthy(),
    );
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const posted = fetchMock.mock.calls.find(
      ([u, init]) =>
        u === '/api/admin/overwrite-dev-from-prod' && init?.method === 'POST',
    );
    expect(JSON.parse(posted[1].body)).toEqual({ confirm: 'overwrite-dev' });
  } finally {
    confirmSpy.mockRestore();
    vi.unstubAllGlobals();
  }
});

test('non-admin users see no Admin section', async () => {
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
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  await waitFor(() => expect(screen.getAllByText('Feedback').length).toBeGreaterThan(0));
  expect(screen.queryByText('Admin')).toBeNull();
  vi.unstubAllGlobals();
});

test('deck chat sends the question and shows the answer with cited cards', async () => {
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Bio', total: 1, due: 0, due_today: 0, new: 1 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u === '/api/chat' && init?.method === 'POST') {
      const payload = JSON.parse(init.body);
      expect(payload.message).toBe('what makes energy?');
      return body({
        answer: 'The powerhouse of the cell.',
        model: 'test-model',
        cards: [
          { card_id: 'c1', front_text: 'Mitochondria', deck_name: 'Bio', score: 0.9 },
        ],
      });
    }
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Chat')[0]);
  await waitFor(() => expect(screen.getByLabelText('Ask about your cards')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Ask about your cards'), {
    target: { value: 'what makes energy?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(screen.getByText('The powerhouse of the cell.')).toBeTruthy(),
  );
  expect(screen.getByText('Bio: Mitochondria')).toBeTruthy();
  vi.unstubAllGlobals();
});

test('stats view shows the review activity heatmap', async () => {
  const todayIso = new Date().toISOString().slice(0, 10);
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
      if (u === '/api/stats')
        return body({
          totals: { cards: 10, new: 3, learning: 1, review: 5, suspended: 1, due: 2 },
          today: { studied: 4, new: 1, reviews: 5, accuracy: 80.0 },
          forecast: [{ date: '2026-11-08', due: 2 }],
          review_history: [{ date: todayIso, reviews: 2 }],
        });
      if (u === '/api/build-info')
        return body({ server_started_at: '2026-11-12T14:05:00+00:00', server_git_sha: null });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByTestId('review-heatmap')).toBeTruthy());
  expect(
    within(screen.getByTestId('review-heatmap')).getByTitle(/2 reviews/),
  ).toBeTruthy();
  vi.unstubAllGlobals();
});

test('add view warns about near-duplicates while typing', async () => {
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
      if (u.startsWith('/api/decks/d1/duplicates')) {
        if (u.includes('front=Mito')) {
          return body({
            duplicates: [
              { card_id: 'c9', front_text: 'Mitochondria', kind: 'exact', score: null },
            ],
          });
        }
        return body({ duplicates: [] });
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Add new card')[0]);
  await waitFor(() => expect(screen.getByLabelText('Question')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Mito' } });
  await waitFor(() =>
    expect(screen.getByText(/Possible duplicate of 1 existing card/)).toBeTruthy(),
  );
  expect(screen.getByText(/Mitochondria/)).toBeTruthy();
  vi.unstubAllGlobals();
});

test('generate page proposes cards and adds only the ticked ones', async () => {
  const created: any[] = [];
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 0, due: 0, due_today: 0, new: 0 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u === '/api/cards/generate' && init?.method === 'POST') {
      return body({
        suggestions: [
          { front: 'Q1', back: 'A1' },
          { front: 'Q2', back: 'A2' },
        ],
        model: 'test-model',
      });
    }
    if (u === '/api/cards' && init?.method === 'POST') {
      created.push(JSON.parse(init.body));
      return { ok: true, status: 201, json: () => Promise.resolve({}) };
    }
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Generate cards')[0]);
  await waitFor(() => expect(screen.getByLabelText('Paste content')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Paste content'), {
    target: { value: 'Some study content' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Propose cards' }));
  await waitFor(() => expect(screen.getByText('Q1')).toBeTruthy());
  expect(screen.getByText('Q2')).toBeTruthy();
  // Untick the second proposal: only the first is created.
  fireEvent.click(screen.getByLabelText('Keep proposal 2'));
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected' }));
  await waitFor(() => expect(screen.getByText('1 card added.')).toBeTruthy());
  expect(created).toHaveLength(1);
  expect(created[0].front).toBe('Q1');
  vi.unstubAllGlobals();
});

test('stats view shows streak, goal progress, and saves preferences', async () => {
  const puts: any[] = [];
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
        streak: 6,
        goal: { target: 20, studied: 4, met: false },
      });
    if (u === '/api/preferences' && (!init?.method || init.method === 'GET'))
      return body({ daily_goal: 20, reminder_enabled: false });
    if (u === '/api/preferences' && init?.method === 'PUT') {
      const payload = JSON.parse(init.body);
      puts.push(payload);
      return body({ daily_goal: payload.daily_goal ?? 20, reminder_enabled: true });
    }
    if (u === '/api/build-info')
      return body({ server_started_at: '2026-11-12T14:05:00+00:00', server_git_sha: null });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByText('Day streak')).toBeTruthy());
  expect(screen.getByTestId('daily-goal')).toHaveTextContent('4/20');
  fireEvent.change(screen.getByLabelText('Daily goal (cards)'), {
    target: { value: '30' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
  await waitFor(() =>
    expect(puts.some((p) => p.daily_goal === 30)).toBe(true),
  );
  vi.unstubAllGlobals();
});

test('stats scheduler section optimizes and reports log-loss', async () => {
  let tuned = false;
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
    if (u === '/api/preferences') return body({ daily_goal: 20, reminder_enabled: false });
    if (u === '/api/fsrs')
      return body({
        custom: tuned,
        parameters: Array(21).fill(0.5),
        default_parameters: Array(21).fill(0.5),
        review_count: 60,
        reviews_used: tuned ? 57 : 0,
        log_loss_before: null,
        log_loss_after: null,
        updated_at: null,
      });
    if (u === '/api/fsrs/optimize' && init?.method === 'POST') {
      tuned = true;
      return body({
        parameters: Array(21).fill(0.5),
        log_loss_before: 0.7,
        log_loss_after: 0.6,
        reviews_used: 57,
      });
    }
    if (u === '/api/build-info')
      return body({ server_started_at: '2026-11-12T14:05:00+00:00', server_git_sha: null });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByTestId('fsrs-status')).toBeTruthy());
  expect(screen.getByTestId('fsrs-status')).toHaveTextContent('Library defaults');
  fireEvent.click(screen.getByRole('button', { name: 'Optimize on my reviews' }));
  await waitFor(() =>
    expect(screen.getByText(/Tuned on 57 reviews/)).toBeTruthy(),
  );
  expect(screen.getByTestId('fsrs-status')).toHaveTextContent('Tuned weights');
  vi.unstubAllGlobals();
});

test('stats view shows retention, workload, and calendar', async () => {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
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
      if (u === '/api/stats')
        return body({
          totals: { cards: 10, new: 3, learning: 1, review: 5, suspended: 1, due: 2 },
          today: { studied: 4, new: 1, reviews: 5, accuracy: 80.0 },
          forecast: [{ date: todayIso, due: 2 }],
          review_history: [{ date: todayIso, reviews: 3 }],
          retention: [
            { bucket: 'learning', reviews: 1, correct: 1, rate: 100.0 },
            { bucket: 'young', reviews: 2, correct: 1, rate: 50.0 },
            { bucket: 'mature', reviews: 0, correct: 0, rate: null },
          ],
          workload: [{ date: todayIso, due: 2, new: 20 }],
        });
      if (u === '/api/preferences') return body({ daily_goal: 20, reminder_enabled: false });
      if (u === '/api/fsrs')
        return body({
          custom: false, parameters: [], default_parameters: [],
          review_count: 0, reviews_used: 0,
          log_loss_before: null, log_loss_after: null, updated_at: null,
        });
      if (u === '/api/build-info')
        return body({ server_started_at: '2026-11-12T14:05:00+00:00', server_git_sha: null });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByTestId('retention-table')).toBeTruthy());
  expect(screen.getByTestId('retention-table')).toHaveTextContent('young');
  expect(screen.getByTestId('retention-table')).toHaveTextContent('50%');
  expect(screen.getByTestId('workload-table')).toHaveTextContent('Total');
  await waitFor(() => expect(screen.getByTestId('stats-calendar')).toBeTruthy());
  expect(screen.getByTestId('stats-calendar')).toHaveTextContent(
    today.toLocaleString('default', { month: 'long' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy());
  vi.unstubAllGlobals();
});

test('browse deck settings save budget and order', async () => {
  let order = 'position';
  let limit: number | null = null;
  const puts: any[] = [];
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks' && (!init?.method || init.method === 'GET'))
      return body({
        decks: [
          {
            id: 'd1', name: 'Test', total: 2, due: 0, due_today: 0, new: 2,
            new_cards_per_day: limit, new_order: order, new_limit: limit ?? 20,
          },
        ],
      });
    if (u === '/api/decks/d1' && init?.method === 'PUT') {
      const payload = JSON.parse(init.body);
      puts.push(payload);
      if (payload.new_cards_per_day != null && payload.new_cards_per_day !== 0)
        limit = payload.new_cards_per_day;
      if (payload.new_order) order = payload.new_order;
      return body({ id: 'd1', name: 'Test', new_cards_per_day: limit, new_order: order, new_limit: limit ?? 20 });
    }
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u.startsWith('/api/decks/d1/cards'))
      return body({ cards: [], total: 0 });
    if (u.startsWith('/api/decks/d1/duplicates')) return body({ duplicates: [] });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByLabelText(/New cards\/day/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText(/New cards\/day/), { target: { value: '5' } });
  fireEvent.mouseDown(screen.getByLabelText('New-card order'));
  await waitFor(() => expect(screen.getByRole('option', { name: 'Newest first' })).toBeTruthy());
  fireEvent.click(screen.getByRole('option', { name: 'Newest first' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save deck settings' }));
  await waitFor(() =>
    expect(
      puts.some((p) => p.new_cards_per_day === 5 && p.new_order === 'newest'),
    ).toBe(true),
  );
  vi.unstubAllGlobals();
});

test('scheduler steps save to the server', async () => {
  const puts: any[] = [];
  const fetchMock = vi.fn(async (url: any, init?: any) => {
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
    if (u === '/api/preferences') return body({ daily_goal: 20, reminder_enabled: false });
    if (u === '/api/fsrs')
      return body({
        custom: false, parameters: [], default_parameters: [],
        review_count: 0, reviews_used: 0,
        log_loss_before: null, log_loss_after: null, updated_at: null,
        learning_steps: [1, 10], relearning_steps: [10],
      });
    if (u === '/api/fsrs/settings' && init?.method === 'PUT') {
      puts.push(JSON.parse(init.body));
      return body({ learning_steps: [15], relearning_steps: [10] });
    }
    if (u === '/api/build-info')
      return body({ server_started_at: '2026-11-12T14:05:00+00:00', server_git_sha: null });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getByText('Stats'));
  await waitFor(() => expect(screen.getByLabelText('Learning steps (min)')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Learning steps (min)'), {
    target: { value: '15' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save steps' }));
  await waitFor(() =>
    expect(
      puts.some((p) => JSON.stringify(p.learning_steps) === '[15]'),
    ).toBe(true),
  );
  vi.unstubAllGlobals();
});

test('browse tag filter narrows the list by tag', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 2, due: 0, due_today: 0, new: 2, new_cards_per_day: null, new_order: 'position', new_limit: 20 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u.startsWith('/api/decks/d1/cards')) {
      const tagged = u.includes('tag=biology');
      const row = (id: string, front: string, tags: string[]) => ({
        card_id: id, front_text: front, tags, due: '2026-11-08',
        last_review: null, state: 2, reps: 1, suspended: false, due_today: true,
      });
      const cards = tagged
        ? [row('c1', 'Tagged Q', ['biology'])]
        : [row('c1', 'Tagged Q', ['biology']), row('c2', 'Plain Q', [])];
      return body({ cards, total: cards.length });
    }
    if (u.startsWith('/api/decks/d1/duplicates')) return body({ duplicates: [] });
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Plain Q')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'biology' } });
  await waitFor(() => expect(screen.queryByText('Plain Q')).toBeNull());
  expect(screen.getByText('Tagged Q')).toBeTruthy();
  expect(
    fetchMock.mock.calls.some(([u]) => String(u).includes('tag=biology')),
  ).toBe(true);
  vi.unstubAllGlobals();
});

test('browse detail saves tags and bulk tagging applies to selection', async () => {
  const patched: any[] = [];
  let bulked: any = null;
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 1, due: 0, due_today: 0, new: 1, new_cards_per_day: null, new_order: 'position', new_limit: 20 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [] });
    if (u.startsWith('/api/decks/d1/cards'))
      return body({
        cards: [{
          card_id: 'c1', card_number: 1, front_text: 'Tagged Q', tags: [],
          due: '2026-11-08', last_review: null, created_at: null,
          state: 2, reps: 1, suspended: false, due_today: true,
        }],
        total: 1,
      });
    if (u === '/api/cards/c1' && (!init?.method || init.method === 'GET'))
      return body({
        card_id: 'c1', deck_id: 'd1', front_html: 'Q', back_html: 'A',
        due: '2026-11-08', state: 2, reps: 1, tags: [],
      });
    if (u === '/api/cards/c1/tags' && init?.method === 'PATCH') {
      patched.push(JSON.parse(init.body));
      return body({ card_id: 'c1', tags: ['biology'] });
    }
    if (u === '/api/cards/bulk-tags' && init?.method === 'POST') {
      bulked = JSON.parse(init.body);
      return body({ updated: 1 });
    }
    if (u.startsWith('/api/decks/d1/duplicates')) return body({ duplicates: [] });
    throw new Error(`unexpected fetch ${u} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('menu'));
  fireEvent.click(screen.getAllByText('Browse')[0]);
  await waitFor(() => expect(screen.getByText('Tagged Q')).toBeTruthy());
  fireEvent.click(screen.getByText('Tagged Q'));
  await waitFor(() => expect(screen.getByTestId('browse-detail')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Tags (comma-separated)'), {
    target: { value: 'Biology' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save tags' }));
  await waitFor(() =>
    expect(patched.some((p) => JSON.stringify(p.tags) === '["Biology"]')).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByTestId('browse-detail')).toBeNull());
  fireEvent.click(screen.getByLabelText('Select card 1'));
  fireEvent.change(screen.getByLabelText('Add tags'), { target: { value: 'x, y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(bulked).not.toBeNull());
  expect(bulked).toMatchObject({ card_ids: ['c1'], add: ['x', 'y'], remove: [] });
  vi.unstubAllGlobals();
});

test('review header counts new cards and names the next due time', async () => {
  const future = new Date(Date.now() + 5 * 60000).toISOString();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
      if (u === '/api/config') return body({ googleClientId: null });
      if (u === '/api/me') return body({ email: 't@example.com' });
      if (u === '/api/decks')
        return body({
          decks: [
            { id: 'd1', name: 'Test', total: 2, due: 0, due_today: 0, new: 2, new_cards_per_day: null, new_order: 'position', new_limit: 20, new_due: 2 },
          ],
        });
      if (u.startsWith('/api/next'))
        return body({ cards: [], next_due_at: future });
      if (u === '/api/stats')
        return body({
          totals: { cards: 2, new: 2, learning: 0, review: 0, suspended: 0, due: 0 },
          today: { studied: 0, new: 0, reviews: 0, accuracy: null },
        });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByText(/0 due today/)).toBeTruthy());
  expect(screen.getByText(/2 new today/)).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/next card in/)).toBeTruthy());
  vi.unstubAllGlobals();
});

test('add view dictates into question and answer separately', async () => {
  class FakeRecognition {
    static instances: any[] = [];
    lang = '';
    interimResults = false;
    continuous = false;
    onresult: any = null;
    onend: any = null;
    onerror: any = null;
    constructor() {
      FakeRecognition.instances.push(this);
    }
    start() {
      // Deliver one final transcript, then end.
      this.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: 'dictated words' } }],
      });
      this.onend?.();
    }
    stop() {}
  }
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    const body = (v: any) => ({ ok: true, json: () => Promise.resolve(v) });
    if (u === '/api/config') return body({ googleClientId: null });
    if (u === '/api/me') return body({ email: 't@example.com' });
    if (u === '/api/decks')
      return body({
        decks: [{ id: 'd1', name: 'Test', total: 0, due: 0, due_today: 0, new: 0, new_cards_per_day: null, new_order: 'position', new_limit: 20, new_due: 0 }],
      });
    if (u.startsWith('/api/next')) return body({ cards: [], next_due_at: null });
    if (u.startsWith('/api/decks/d1/duplicates')) return body({ duplicates: [] });
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('menu')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('menu'));
    fireEvent.click(screen.getAllByText('Add new card')[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dictate question' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Dictate question' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Question')).toHaveValue('dictated words'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dictate answer' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Answer')).toHaveValue('dictated words'),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
