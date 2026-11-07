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
  new: number;
}

export async function getDecks(): Promise<Deck[]> {
  const res = await apiFetch('/decks');
  const data = await readJson(res);
  return data.decks ?? [];
}

export interface ReviewCard {
  card_id: string;
  deck_id: string;
  front_html: string;
  back_html: string;
  due: string;
  state: string;
  reps: number;
}

export async function getNext(deckId: string | ''): Promise<ReviewCard[]> {
  const q = deckId ? `?deck_id=${encodeURIComponent(deckId)}&limit=1` : '?limit=1';
  const res = await apiFetch(`/next${q}`);
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
}

export const BROWSE_PAGE = 20;

export async function browseCards(
  deckId: string,
  sort: BrowseSort,
  direction: BrowseDir,
  skip: number,
  limit: number = BROWSE_PAGE,
): Promise<{ cards: BrowseCard[]; total: number }> {
  const q =
    `?sort=${sort}&direction=${direction}&skip=${skip}&limit=${limit}`;
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

/** Compact date like the legacy page: "M/d h:mm", em dash when missing. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
