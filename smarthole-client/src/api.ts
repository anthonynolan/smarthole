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
  is_admin?: boolean;
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
  return { email: data.email, is_admin: data.is_admin === true };
}

/**
 * Replace ALL dev data with the production database (admin only, and only
 * when the server runs on a non-production database). Sessions are copied
 * too, so the caller must log in again afterwards.
 */
export interface OverwriteDevResult {
  overwritten: boolean;
  from: string;
  to: string;
  collections: Record<string, number>;
  relogin_required: boolean;
}

export async function overwriteDevFromProd(): Promise<OverwriteDevResult> {
  const res = await apiFetch('/admin/overwrite-dev-from-prod', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'overwrite-dev' }),
  });
  return readJson(res);
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
  new_cards_per_day: number | null;
  new_order: string;
  new_limit: number;
  new_due: number;
}

export async function getDecks(): Promise<Deck[]> {
  const res = await apiFetch('/decks');
  const data = await readJson(res);
  return data.decks ?? [];
}

export interface DeckSettings {
  new_cards_per_day?: number | null;
  new_order?: string;
}

/** Update a deck's new-card budget (0 resets to default) and gather order. */
export async function updateDeckSettings(
  deckId: string,
  settings: { new_cards_per_day?: number; new_order?: string },
): Promise<DeckSettings & { id: string; name: string; new_limit: number }> {
  const res = await apiFetch(`/decks/${encodeURIComponent(deckId)}`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
  return readJson(res);
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
  tags?: string[];
  /** Next-due ISO timestamps per rating ("1".."4"), for button labels. */
  intervals?: Record<string, string>;
  /** Full card + scheduling metadata for troubleshooting. */
  meta?: CardMeta | null;
}

export interface NextQueue {
  cards: ReviewCard[];
  /** Earliest future due (UTC ISO): when the next card matures. */
  next_due_at: string | null;
}

export async function getNext(
  deckId: string | '',
  excludeId?: string,
): Promise<NextQueue> {
  const q = deckId ? `?deck_id=${encodeURIComponent(deckId)}&limit=1` : '?limit=1';
  const ex = excludeId ? `&exclude=${encodeURIComponent(excludeId)}` : '';
  const res = await apiFetch(`/next${q}${ex}`);
  const data = await readJson(res);
  return { cards: data.cards ?? [], next_due_at: data.next_due_at ?? null };
}

export async function gradeCard(cardId: string, rating: number): Promise<ReviewCard> {
  const res = await apiFetch(`/review/${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body: JSON.stringify({ rating }),
  });
  return readJson(res);
}

/** Full review payload for one card (used to queue a related card next). */
export async function getCard(cardId: string): Promise<ReviewCard> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}`);
  return readJson(res);
}

export interface RelatedCard {
  card_id: string;
  front_text: string;
  deck_name: string;
  score: number;
}

/** Cards most similar to this one (empty + unavailable when not indexed). */
export async function getRelated(
  cardId: string,
  limit = 3,
): Promise<{ cards: RelatedCard[]; unavailable: boolean }> {
  const res = await apiFetch(
    `/cards/${encodeURIComponent(cardId)}/related?limit=${limit}`,
  );
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

export interface DuplicateCard {
  card_id: string;
  front_text: string;
  kind: 'exact' | 'similar';
  score: number | null;
}

/** Existing cards near-identical to a prospective new one (non-blocking). */
export async function checkDuplicates(
  deckId: string,
  front: string,
  back: string,
): Promise<DuplicateCard[]> {
  let q = `?front=${encodeURIComponent(front)}&back=${encodeURIComponent(back)}`;
  const res = await apiFetch(`/decks/${encodeURIComponent(deckId)}/duplicates${q}`);
  const data = await readJson(res);
  return data.duplicates ?? [];
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

export type BrowseSort = 'due' | 'last_review' | 'created_at' | 'card_number';
export type BrowseDir = 'asc' | 'desc';

export interface BrowseCard {
  card_id: string;
  card_number?: number | null;
  front_text: string;
  due: string | null;
  last_review: string | null;
  created_at?: string | null;
  state: string;
  reps: number;
  suspended: boolean;
  deleted?: boolean;
  created_via_mcp?: boolean;
  /** True when the card counts as due today (drives the divider line). */
  due_today: boolean;
  tags?: string[];
}

export const BROWSE_PAGE = 50;

export async function browseCards(
  deckId: string,
  sort: BrowseSort,
  direction: BrowseDir,
  skip: number,
  limit: number = BROWSE_PAGE,
  search?: string,
  showDeleted = false,
  mcpOnly = false,
  suspendedOnly = false,
  tag?: string,
): Promise<{ cards: BrowseCard[]; total: number }> {
  let q =
    `?sort=${sort}&direction=${direction}&skip=${skip}&limit=${limit}`;
  if (search) q += `&q=${encodeURIComponent(search)}`;
  if (showDeleted) q += '&show_deleted=true';
  if (mcpOnly) q += '&mcp_only=true';
  if (suspendedOnly) q += '&suspended_only=true';
  if (tag) q += `&tag=${encodeURIComponent(tag)}`;
  const res = await apiFetch(`/decks/${encodeURIComponent(deckId)}/cards${q}`);
  return readJson(res);
}

/** Replace a card's tags (lowercased, deduped server-side). */
export async function setCardTags(
  cardId: string,
  tags: string[],
): Promise<{ card_id: string; tags: string[] }> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/tags`, {
    method: 'PATCH',
    body: JSON.stringify({ tags }),
  });
  return readJson(res);
}

/** Add and/or remove tags on many cards at once. */
export async function bulkTagCards(
  cardIds: string[],
  add: string[],
  remove: string[],
): Promise<{ updated: number }> {
  const res = await apiFetch('/cards/bulk-tags', {
    method: 'POST',
    body: JSON.stringify({ card_ids: cardIds, add, remove }),
  });
  return readJson(res);
}

/** Suspend a card (stays in Browse, leaves the review queue). */
export async function suspendCard(cardId: string): Promise<void> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/suspend`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await readJson(res);
}

/** Return a suspended card to the review queue. */
export async function unsuspendCard(cardId: string): Promise<void> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/unsuspend`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await readJson(res);
}

/** Reschedule a card by setting its due date (ISO datetime string). */
export async function setCardDue(
  cardId: string,
  due: string,
): Promise<{ card_id: string; due: string }> {
  const res = await apiFetch(`/cards/${encodeURIComponent(cardId)}/due`, {
    method: 'PUT',
    body: JSON.stringify({ due }),
  });
  return readJson(res);
}

export type ChatRole = 'user' | 'assistant';

export interface ChatHistoryMessage {
  role: ChatRole;
  text: string;
}

export interface ChatCitedCard {
  card_id: string;
  front_text: string;
  deck_name: string;
  score: number;
}

export interface ChatReply {
  answer: string;
  model: string;
  cards: ChatCitedCard[];
}

/**
 * Ask a study question across the caller's cards (all decks, or just
 * `deckIds`). Answers tutor-style with the retrieved cards named.
 */
export async function chatDeck(
  message: string,
  deckIds?: string[],
  history?: ChatHistoryMessage[],
): Promise<ChatReply> {
  const res = await apiFetch('/chat', {
    method: 'POST',
    body: JSON.stringify({
      message,
      ...(deckIds && deckIds.length > 0 ? { deck_ids: deckIds } : {}),
      ...(history && history.length > 0 ? { history } : {}),
    }),
  });
  return readJson(res);
}

/** Propose Anki cards from pasted content (no writes; verify before creating). */
export async function generateCards(
  deckId: string,
  content: string,
): Promise<{ suggestions: AiSuggestion[]; model: string }> {
  const res = await apiFetch('/cards/generate', {
    method: 'POST',
    body: JSON.stringify({ deck_id: deckId, content }),
  });
  return readJson(res);
}

/** Download an .apkg export of one or more decks. */
export async function exportDecks(deckIds: string[]): Promise<void> {
  const q = `?deck_ids=${encodeURIComponent(deckIds.join(','))}`;
  const res = await fetch(`/api/export${q}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Request failed: ${res.status}`);
  }
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    'smarthole-export.apkg';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
  streak?: number;
  goal?: {
    target: number;
    studied: number;
    met: boolean;
  };
  retention?: Array<{
    bucket: string;
    reviews: number;
    correct: number;
    rate: number | null;
  }>;
  workload?: Array<{ date: string; due: number; new: number }>;
  forecast: Array<{ date: string; due: number }>;
  added_per_day?: Array<{ date: string; added: number }>;
  review_history?: Array<{ date: string; reviews: number }>;
}

export async function getStats(): Promise<Stats> {
  const res = await apiFetch('/stats');
  return readJson(res);
}

/** Distinct cards studied today (lightweight review-header count). */
export async function getToday(): Promise<{ studied: number }> {
  const res = await apiFetch('/today');
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
 * "10m", "3h", "23d", "1.3mo", "2y". Empty string when unknown.
 *
 * Months and years keep one decimal (trailing ".0" trimmed) so nearby
 * grades stay distinguishable: flooring to whole months collapses
 * genuinely different due dates (e.g. 39d and 47d) into one label.
 */
export function fmtInterval(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const daysExact = hours / 24;
  if (daysExact < 30) return `${Math.floor(daysExact)}d`;
  const monthsExact = daysExact / 30.44;
  if (monthsExact < 12) return `${trim1(monthsExact)}mo`;
  return `${trim1(monthsExact / 12)}y`;
}

/** One decimal, dropping a trailing ".0" ("2.0" -> "2"). */
function trim1(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded);
}

export type FeedbackStatus = 'submitted' | 'in_progress' | 'resolved';

export interface FeedbackItem {
  id: string;
  email: string;
  username: string;
  text: string;
  screen: string;
  status: FeedbackStatus;
  created_at: string | null;
}

/** Submit app feedback (starts with status "submitted"). */
export async function submitFeedback(
  text: string,
  screen?: string,
): Promise<FeedbackItem> {
  const res = await apiFetch('/feedback', {
    method: 'POST',
    body: JSON.stringify({ text, screen: screen ?? '' }),
  });
  return readJson(res);
}

/** The caller's own feedback, newest first. */
export async function getOwnFeedback(): Promise<FeedbackItem[]> {
  const res = await apiFetch('/feedback');
  const data = await readJson(res);
  return data.feedback ?? [];
}

export interface FeedbackFilter {
  status?: string;
  email?: string;
}

/**
 * Everyone's feedback (admin only; 403 otherwise). Filter by status
 * and/or user email.
 */
export async function getAllFeedback(
  filter?: FeedbackFilter,
): Promise<FeedbackItem[]> {
  let q = '';
  if (filter?.status) q += `?status=${encodeURIComponent(filter.status)}`;
  if (filter?.email) q += `${q ? '&' : '?'}email=${encodeURIComponent(filter.email)}`;
  const res = await apiFetch(`/feedback/all${q}`);
  const data = await readJson(res);
  return data.feedback ?? [];
}

/** Change a feedback item's status (admin only). */
export async function setFeedbackStatus(
  id: string,
  status: FeedbackStatus,
): Promise<FeedbackItem> {
  const res = await apiFetch(`/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  return readJson(res);
}

/** Download the filtered feedback set as CSV (admin only). */
export async function exportFeedback(filter?: FeedbackFilter): Promise<void> {
  let q = '';
  if (filter?.status) q += `?status=${encodeURIComponent(filter.status)}`;
  if (filter?.email) q += `${q ? '&' : '?'}email=${encodeURIComponent(filter.email)}`;
  const res = await fetch(`/api/feedback/export${q}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Request failed: ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'feedback.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export interface Preferences {
  daily_goal: number;
  reminder_enabled: boolean;
}

/** The caller's study preferences (daily goal, email reminders). */
export async function getPreferences(): Promise<Preferences> {
  const res = await apiFetch('/preferences');
  return readJson(res);
}

/** Update study preferences (partial). */
export async function updatePreferences(
  prefs: Partial<Preferences>,
): Promise<Preferences> {
  const res = await apiFetch('/preferences', {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });
  return readJson(res);
}

export interface FsrsStatus {
  custom: boolean;
  parameters: number[];
  default_parameters: number[];
  review_count: number;
  reviews_used: number;
  log_loss_before: number | null;
  log_loss_after: number | null;
  updated_at: string | null;
  learning_steps: number[];
  relearning_steps: number[];
}

/** Set learning/relearning steps in minutes (tuned weights kept). */
export async function updateFsrsSettings(settings: {
  learning_steps?: number[];
  relearning_steps?: number[];
}): Promise<{ learning_steps: number[]; relearning_steps: number[] }> {
  const res = await apiFetch('/fsrs/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
  return readJson(res);
}

export interface FsrsOptimizeResult {
  parameters: number[];
  log_loss_before: number;
  log_loss_after: number;
  reviews_used: number;
}

/** Current scheduler weights: tuned or library defaults. */
export async function getFsrsStatus(): Promise<FsrsStatus> {
  const res = await apiFetch('/fsrs');
  return readJson(res);
}

/** Tune FSRS weights on the caller's review history. */
export async function optimizeFsrs(): Promise<FsrsOptimizeResult> {
  const res = await apiFetch('/fsrs/optimize', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return readJson(res);
}

/** Forget tuned weights; return to library defaults. */
export async function resetFsrs(): Promise<{ reset: boolean }> {
  const res = await apiFetch('/fsrs/reset', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return readJson(res);
}

/** Replay every reviewed card's history through the current scheduler. */
export async function rescheduleFsrs(): Promise<{ rescheduled: number }> {
  const res = await apiFetch('/fsrs/reschedule', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return readJson(res);
}

export interface BuildInfo {
  server_started_at: string;
  server_git_sha: string | null;
}

/** When the server last restarted, and from which commit. */
export async function getBuildInfo(): Promise<BuildInfo> {
  const res = await apiFetch('/build-info');
  return readJson(res);
}

/**
 * When this UI bundle was built (baked in at build time by vite.config.ts;
 * "dev" for unbuilt dev servers).
 */
export const UI_BUILD_AT: string =
  typeof __UI_BUILD_TIME__ !== 'undefined' ? __UI_BUILD_TIME__ : 'dev';

declare const __UI_BUILD_TIME__: string;

/**
 * Date and time like "12-Nov'26 14:05 UTC" ("dev" passes through, em dash
 * when missing). Used for deploy/build stamps.
 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (iso === 'dev') return 'dev';
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fmtDate(iso)} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())} UTC`;
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
