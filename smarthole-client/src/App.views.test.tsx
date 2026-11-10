import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  // The partial output is visible before the stream completes.
  await waitFor(() => expect(screen.getByTestId('ai-stream')).toBeTruthy());
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
    }),
  );
  render(<App />);
  // The related hint shows the closest card as a title link.
  await waitFor(() => expect(screen.getByTestId('related-hint')).toBeTruthy());
  expect(screen.getByTestId('related-hint')).toHaveTextContent('Q2');
  // Clicking it queues the related card instead of navigating away.
  fireEvent.click(screen.getByText('Q2'));
  await waitFor(() => expect(screen.getByTestId('queued-next')).toBeTruthy());
  expect(screen.getByTestId('queued-next')).toHaveTextContent('Q2');
  // Grading the current card shows the queued card next.
  fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
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
