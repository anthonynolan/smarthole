// Same-origin API helper. All calls go to /api with cookies included.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

async function readJson(res: Response): Promise<any> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json();
}

export interface AppConfig {
  googleClientId: string;
}

// Runtime config loaded from GET /api/config. The Google client ID is never
// hardcoded; it arrives from the backend at startup.
export async function loadConfig(): Promise<AppConfig> {
  const res = await apiFetch('/config');
  if (!res.ok) {
    throw new Error(`GET /api/config failed: ${res.status}`);
  }
  const data = await res.json();
  const googleClientId: string =
    data.googleClientId ?? data.google_client_id ?? data.clientId ?? '';
  return { googleClientId };
}

export interface Me {
  email: string;
}

export async function getMe(): Promise<Me | null> {
  const res = await apiFetch('/me');
  if (res.status === 401) return null;
  if (!res.ok) {
    if (res.status === 403) return null;
    throw new Error(`GET /api/me failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data || typeof data.email !== 'string') return null;
  return { email: data.email };
}

export async function login(email: string, password: string): Promise<Me> {
  const res = await apiFetch('/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return readJson(res);
}

export async function register(email: string, password: string): Promise<Me> {
  const res = await apiFetch('/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return readJson(res);
}

export async function googleLogin(token: string): Promise<Me> {
  const res = await apiFetch('/google', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  return readJson(res);
}

export async function logout(): Promise<void> {
  await apiFetch('/logout', { method: 'POST', body: JSON.stringify({}) });
}

export interface Deck {
  id: string;
  name: string;
  total: number;
  due: number;
  due_today: number;
  new: number;
}

export async function getDecks(): Promise<Deck[]> {
  const res = await apiFetch('/decks');
  const data = await readJson(res);
  return data.decks ?? [];
}

export interface CardMeta {
  card_id: string;
  deck_id: string;
  deck_name: string;
  created_at?: string | null;
  suspended: boolean;
  deleted: boolean;
  deleted_at?: string | null;
  new_position: number;
  anki_nid?: number | null;
  anki_ord?: number | null;
  anki_guid?: string | null;
  due?: string | null;
  last_review?: string | null;
  state: number;
  step: number;
  stability?: number | null;
  difficulty?: number | null;
  reps: number;
  lapses: number;
  introduced_at?: string | null;
}

export interface ReviewCard {
  card_id: string;
  deck_id: string;
  deck_name?: string;
  front_html: string;
  back_html: string;
  due: string;
  state: string;
  reps: number;
  created_at?: string | null;
  /** Next-due ISO timestamps per rating ("1".."4"), for button labels. */
  intervals?: Record<string, string>;
  /** Full card + scheduling metadata for troubleshooting. */
  meta?: CardMeta | null;
}

export async function getNext(
  deckId: string | '',
  excludeId?: string,
): Promise<ReviewCard[]> {
  const q = deckId ? `?deck_id=${encodeURIComponent(deckId)}&limit=1` : '?limit=1';
  const ex = excludeId ? `&exclude=${encodeURIComponent(excludeId)}` : '';
  const res = await apiFetch(`/next${q}${ex}`);
  const data = await readJson(res);
  return data.cards ?? [];
}

export async function gradeCard(cardId: string, rating: number): Promise<ReviewCard> {
  const res = await apiFetch(`/review/${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body: JSON.stringify({ rating }),
  });
  return readJson(res);
}

export interface AiSuggestion {
  front: string;
  back: string;
}

export async function requestAiReview(
  cardId: string,
  opts?: { mode: AiReviewMode; question?: string },
): Promise<{ suggestions: AiSuggestion[]; answer?: string; model: string }> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/ai-review`, {
    method: 'POST',
    body: JSON.stringify(
      opts?.mode === 'custom'
        ? { mode: 'custom', question: opts.question ?? '' }
        : {},
    ),
  });
  return readJson(res);
}

export type AiReviewMode = 'split' | 'custom';

export interface AiReviewStreamResult {
  suggestions: AiSuggestion[];
  answer: string | null;
  model: string;
  raw: string;
}

/**
 * Stream an AI review, calling `onText` with the full text received so far
 * as each chunk arrives, and resolving with the parsed final result.
 * `onStatus` reports the call phases: sent → awaiting response →
 * streaming → finished.
 */
export type AiReviewStatus = 'sent' | 'awaiting response' | 'streaming' | 'finished';

export async function requestAiReviewStream(
  cardId: string,
  opts: { mode: AiReviewMode; question?: string },
  onText: (fullText: string) => void,
  onStatus?: (status: AiReviewStatus) => void,
): Promise<AiReviewStreamResult> {
  const q =
    `?mode=${opts.mode}` +
    (opts.mode === 'custom' ? `&question=${encodeURIComponent(opts.question ?? '')}` : '');
  onStatus?.('sent');
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/ai-review/stream${q}`);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Request failed: ${res.status}`);
  }
  onStatus?.('awaiting response');
  if (!res.body) {
    const fallback = await requestAiReview(
      cardId,
      opts.mode === 'custom' ? { mode: opts.mode, question: opts.question } : undefined,
    );
    return {
      suggestions: fallback.suggestions,
      answer: fallback.answer ?? null,
      model: fallback.model,
      raw: '',
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  const flush = (final: boolean) => {
    const lines = buffer.split('\n');
    buffer = final ? '' : (lines.pop() ?? '');
    return final ? [...lines, buffer].filter((l) => l.trim()) : lines;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of flush(false)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      if (typeof event.delta === 'string') {
        raw += event.delta;
        onStatus?.('streaming');
        onText(raw);
      }
      if (event.done) {
        onStatus?.('finished');
        return {
          suggestions: event.suggestions ?? [],
          answer: event.answer ?? null,
          model: event.model ?? '',
          raw,
        };
      }
    }
  }
  buffer += decoder.decode();
  for (const line of flush(true)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.error) throw new Error(event.error);
    if (typeof event.delta === 'string') {
      raw += event.delta;
      onStatus?.('streaming');
      onText(raw);
    }
    if (event.done) {
      onStatus?.('finished');
      return {
        suggestions: event.suggestions ?? [],
        answer: event.answer ?? null,
        model: event.model ?? '',
        raw,
      };
    }
  }
  throw new Error('AI review ended without a result.');
}

/**
 * Delete a card. Default is a logical delete (restorable from Browse's
 * "Show deleted" view); `permanent` hard-deletes the card, its schedule,
 * and its review history.
 */
export async function deleteCard(cardId: string, permanent = false): Promise<void> {
  const res = await apiFetch(
    `/cards/${encodeURIComponent(cardId)}${permanent ? '?permanent=true' : ''}`,
    { method: 'DELETE' },
  );
  await readJson(res);
}

/** Undelete a logically deleted card (schedule/history are intact). */
export async function restoreCard(cardId: string): Promise<void> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/restore`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await readJson(res);
}

export interface UpdatedCard {
  card_id: string;
  deck_id: string;
  front_html: string;
  back_html: string;
}

export async function updateCard(
  cardId: string,
  front: string,
  back: string,
): Promise<UpdatedCard> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}`, {
    method: 'PUT',
    body: JSON.stringify({ front, back }),
  });
  return readJson(res);
}

/**
 * Editable plain text from card HTML (used to prefill the edit fields).
 * Block boundaries (<br>, paragraphs, divs, list items, headings, <hr>)
 * become newlines so line breaks survive the edit round-trip.
 */
export function htmlToText(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = (html ?? '')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|ul|ol|blockquote|pre)>/gi, '\n');
  return (el.textContent ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type BrowseSort = 'due' | 'last_review';
export type BrowseDir = 'asc' | 'desc';

export interface BrowseCard {
  card_id: string;
  front_text: string;
  due: string | null;
  last_review: string | null;
  state: string;
  reps: number;
  suspended: boolean;
  deleted?: boolean;
  /** True when the card counts as due today (drives the divider line). */
  due_today: boolean;
}

export const BROWSE_PAGE = 20;

export async function browseCards(
  deckId: string,
  sort: BrowseSort,
  direction: BrowseDir,
  skip: number,
  limit: number = BROWSE_PAGE,
  search?: string,
  showDeleted = false,
): Promise<{ cards: BrowseCard[]; total: number }> {
  let q =
    `?sort=${sort}&direction=${direction}&skip=${skip}&limit=${limit}`;
  if (search) q += `&q=${encodeURIComponent(search)}`;
  if (showDeleted) q += '&show_deleted=true';
  const res = await apiFetch(`/decks/${encodeURIComponent(deckId)}/cards${q}`);
  return readJson(res);
}

export async function createCard(
  deckId: string,
  front: string,
  back: string,
): Promise<{ card_id: string; deck_id: string }> {
  const res = await apiFetch('/cards', {
    method: 'POST',
    body: JSON.stringify({ deck_id: deckId, front, back }),
  });
  return readJson(res);
}

export interface ImportResult {
  imported: number;
  decks: number;
  scheduling: boolean;
  due: number;
}

export async function importPackage(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/import', {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  return readJson(res);
}

export interface ImportProgress {
  stage: string;
  done: number;
  total: number;
}

/**
 * Import with live progress. Reads the NDJSON event stream from
 * `POST /api/import?stream=true`, calling `onProgress` with cards-processed
 * counts, and resolves with the final import result.
 */
export async function importPackageStream(
  file: File,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/import?stream=true', {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  if (!res.ok) {
    await readJson(res);
    throw new Error('Import failed.');
  }
  if (!res.body) {
    return importPackage(file);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const event = JSON.parse(raw);
      if (event.error) throw new Error(event.error);
      if (event.complete) return event.result as ImportResult;
      if (event.stage) {
        onProgress({
          stage: event.stage,
          done: event.done,
          total: event.total,
        });
      }
    }
  }
  throw new Error('Import ended without a result.');
}

export interface Stats {
  totals: {
    cards: number;
    new: number;
    learning: number;
    review: number;
    suspended: number;
    due: number;
  };
  today: {
    studied: number;
    new: number;
    reviews: number;
    accuracy: number | null;
  };
  forecast: Array<{ date: string; due: number }>;
}

export async function getStats(): Promise<Stats> {
  const res = await apiFetch('/stats');
  return readJson(res);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Unambiguous day-month-year like "12-Nov'26", em dash when missing.
 * Date-only strings ("2026-11-08", as used by the stats forecast) are read
 * as UTC days so the timezone cannot shift them; full timestamps use their
 * UTC day for the same reason.
 */
/**
 * Human interval from now until an ISO due timestamp, Anki-style:
 * "10m", "3h", "23d", "4mo", "2y". Empty string when unknown.
 */
export function fmtInterval(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const bare = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  let y: number;
  let m: number;
  let d: number;
  if (bare) {
    y = Number(bare[1]);
    m = Number(bare[2]);
    d = Number(bare[3]);
  } else {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '—';
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return '—';
  return `${d}-${MONTHS[m - 1]}'${String(y).slice(2)}`;
}
