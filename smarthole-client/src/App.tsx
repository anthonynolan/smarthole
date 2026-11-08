import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Container,
  Drawer,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';
import {
  BROWSE_PAGE,
  browseCards,
  createCard,
  deleteCard,
  fmtDate,
  fmtInterval,
  getDecks,
  getMe,
  getNext,
  getStats,
  googleLogin,
  gradeCard,
  importPackageStream,
  type ImportProgress,
  loadConfig,
  login,
  logout,
  register,
  requestAiReview,
  updateCard,
  htmlToText,
  type AiSuggestion,
  type BrowseCard,
  type Deck,
  type ReviewCard,
  type Stats,
} from './api';

type View = 'review' | 'browse' | 'add' | 'import' | 'stats';

const theme = createTheme({
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      '"Helvetica Neue"',
      'Arial',
      'sans-serif',
    ].join(', '),
    h5: { fontWeight: 600, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600 },
    body1: { lineHeight: 1.6 },
  },
});

/** Long-form study text: larger serif with generous leading and measure. */
const qaTextSx = {
  fontFamily: ['Georgia', '"Times New Roman"', 'Charter', 'serif'].join(', '),
  fontSize: '1.3rem',
  lineHeight: 1.75,
  maxWidth: '68ch',
  overflowWrap: 'break-word' as const,
};

export default function App() {
  const [me, setMe] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [clientId, setClientId] = useState<string>('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [view, setView] = useState<View>('review');
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await getMe().catch(() => null);
        if (!cancelled && m) {
          setMe(m.email);
          setView('review');
        }
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
      try {
        const cfg = await loadConfig();
        if (!cancelled) setClientId(cfg.googleClientId ?? '');
      } catch (e) {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthed = useCallback((email: string) => {
    setMe(email);
    setAuthError(null);
    setView('review');
    setDrawerOpen(false);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout().catch(() => undefined);
    setMe(null);
    setView('review');
    setDrawerOpen(false);
  }, []);

  if (!authChecked) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8, textAlign: 'center' }}>
        <CircularProgress aria-label="loading" />
      </Container>
    );
  }

  if (!me) {
    const wall = (
      <Container maxWidth="sm" sx={{ mt: 4 }}>
        <Typography variant="h4" gutterBottom>
          Smarthole
        </Typography>
        <Typography variant="h6" gutterBottom>
          Sign in
        </Typography>
        {authError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {authError}
          </Alert>
        )}
        {configError && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Google sign-in unavailable: {configError}
          </Alert>
        )}
        <Box sx={{ my: 2 }}>
          {clientId ? (
            <GoogleLogin
              onSuccess={async (cred) => {
                if (!cred.credential) {
                  setAuthError('Google sign-in failed: no credential');
                  return;
                }
                try {
                  const m = await googleLogin(cred.credential);
                  handleAuthed(m.email);
                } catch (e) {
                  setAuthError(e instanceof Error ? e.message : String(e));
                }
              }}
              onError={() => setAuthError('Google sign-in failed')}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">
              Google sign-in is not configured.
            </Typography>
          )}
        </Box>
        <LoginForm onAuthed={handleAuthed} onError={setAuthError} />
        {/* Keeps the scaffold-era contract observable: config value rendered. */}
        <Typography data-testid="google-client-id" sx={{ display: 'none' }} aria-hidden>
          Google client ID: {clientId || '(not configured)'}
        </Typography>
      </Container>
    );
    if (clientId) {
      return <GoogleOAuthProvider clientId={clientId}>{wall}</GoogleOAuthProvider>;
    }
    return wall;
  }

  const shell = (
    <Box sx={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={() => setDrawerOpen(true)}
          >
            <Typography variant="h6" component="span">
              ☰
            </Typography>
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Smarthole
          </Typography>
          <Typography variant="body2">{me}</Typography>
        </Toolbar>
      </AppBar>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <List sx={{ width: 240 }}>
          <ListItemButton
            selected={view === 'review'}
            onClick={() => {
              setView('review');
              setDrawerOpen(false);
            }}
          >
            <ListItemText primary="Review" />
          </ListItemButton>
          <ListItemButton
            selected={view === 'browse'}
            onClick={() => {
              setView('browse');
              setDrawerOpen(false);
            }}
          >
            <ListItemText primary="Browse" />
          </ListItemButton>
          <ListItemButton
            selected={view === 'add'}
            onClick={() => {
              setView('add');
              setDrawerOpen(false);
            }}
          >
            <ListItemText primary="Add new card" />
          </ListItemButton>
          <ListItemButton
            selected={view === 'import'}
            onClick={() => {
              setView('import');
              setDrawerOpen(false);
            }}
          >
            <ListItemText primary="Import" />
          </ListItemButton>
          <ListItemButton
            selected={view === 'stats'}
            onClick={() => {
              setView('stats');
              setDrawerOpen(false);
            }}
          >
            <ListItemText primary="Stats" />
          </ListItemButton>
          <ListItemButton onClick={handleLogout}>
            <ListItemText primary="Logout" />
          </ListItemButton>
        </List>
      </Drawer>
      <Container maxWidth="md" sx={{ mt: 2, mb: 6 }}>
        {view === 'review' && <ReviewView />}
        {view === 'browse' && <BrowseView />}
        {view === 'add' && <AddView />}
        {view === 'import' && <ImportView />}
        {view === 'stats' && <StatsView />}
      </Container>
    </Box>
  );
  const themed = (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {shell}
    </ThemeProvider>
  );
  if (clientId) {
    return <GoogleOAuthProvider clientId={clientId}>{themed}</GoogleOAuthProvider>;
  }
  return themed;
}

function LoginForm({
  onAuthed,
  onError,
}: {
  onAuthed: (email: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (mode: 'login' | 'register') => {
    onError(null);
    setBusy(true);
    try {
      const m =
        mode === 'login' ? await login(email, password) : await register(email, password);
      onAuthed(m.email);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxWidth: 360 }}>
      <TextField
        label="Email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant="contained" disabled={busy} onClick={() => submit('login')}>
          Log in
        </Button>
        <Button variant="outlined" disabled={busy} onClick={() => submit('register')}>
          Register
        </Button>
      </Box>
    </Box>
  );
}

function DeckSelect({
  decks,
  value,
  onChange,
  allowAll,
  label,
}: {
  decks: Deck[];
  value: string;
  onChange: (id: string) => void;
  allowAll?: boolean;
  label?: string;
}) {
  return (
    <FormControl fullWidth size="small" sx={{ mb: 2 }}>
      <InputLabel id="deck-select-label">{label ?? 'Deck'}</InputLabel>
      <Select
        labelId="deck-select-label"
        label={label ?? 'Deck'}
        value={value}
        onChange={(e) => onChange(e.target.value as string)}
      >
        {allowAll && (
          <MenuItem value="">
            <em>All decks</em>
          </MenuItem>
        )}
        {decks.map((d) => (
          <MenuItem key={d.id} value={d.id}>
            {d.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function useDecks() {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setDecks(await getDecks());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { decks, error, refresh };
}

function ReviewView() {
  const { decks, error: decksError, refresh } = useDecks();
  const [deckId, setDeckId] = useState('');
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [showBack, setShowBack] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiSelected, setAiSelected] = useState<boolean[]>([]);
  const [aiDeleteOriginal, setAiDeleteOriginal] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiMs, setAiMs] = useState<number | null>(null);
  const [aiElapsed, setAiElapsed] = useState(0);
  const [preloaded, setPreloaded] = useState<ReviewCard | null>(null);
  const [editing, setEditing] = useState(false);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Best-effort preload of the card after the current one, so grading
  // swaps instantly instead of waiting on a fetch.
  const prefetchNext = useCallback(async (deck: string, excludeId: string) => {
    try {
      const cards = await getNext(deck as '', excludeId);
      setPreloaded(cards[0] ?? null);
    } catch {
      setPreloaded(null);
    }
  }, []);

  const loadNext = useCallback(async (deck: string) => {
    setLoading(true);
    setError(null);
    setStatus(null);
    setPreloaded(null);
    setEditing(false);
    setEditError(null);
    setAiOpen(false);
    setAiSuggestions([]);
    setAiSelected([]);
    setAiError(null);
    setAiMs(null);
    try {
      const cards = await getNext(deck as '');
      const first = cards[0] ?? null;
      setCard(first);
      setShowBack(false);
      if (first) void prefetchNext(deck, first.card_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [prefetchNext]);

  useEffect(() => {
    loadNext(deckId);
  }, [deckId, loadNext]);

  const grade = async (rating: number) => {
    if (!card) return;
    setError(null);
    try {
      await gradeCard(card.card_id, rating);
      if (preloaded && preloaded.card_id !== card.card_id) {
        const next = preloaded;
        setPreloaded(null);
        setCard(next);
        setShowBack(false);
        setStatus(null);
        void prefetchNext(deckId, next.card_id);
      } else {
        setStatus('Graded. Loading next card…');
        await loadNext(deckId);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Live elapsed-time counter while the AI call is in flight.
  useEffect(() => {
    if (!aiLoading) return;
    setAiElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setAiElapsed(Date.now() - t0), 100);
    return () => clearInterval(timer);
  }, [aiLoading]);

  const startAiReview = async () => {
    if (!card || aiLoading) return;
    setAiOpen(true);
    setAiLoading(true);
    setAiError(null);
    setAiSuggestions([]);
    setAiSelected([]);
    setAiMs(null);
    const t0 = Date.now();
    try {
      const r = await requestAiReview(card.card_id);
      setAiSuggestions(r.suggestions);
      setAiSelected(r.suggestions.map(() => true));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiMs(Date.now() - t0);
      setAiLoading(false);
    }
  };

  const toggleAi = (i: number) =>
    setAiSelected((prev) => prev.map((v, j) => (j === i ? !v : v)));

  const applyAi = async () => {
    if (!card) return;
    setAiError(null);
    setAiApplying(true);
    try {
      const picked = aiSuggestions.filter((_, i) => aiSelected[i]);
      for (const s of picked) {
        await createCard(card.deck_id, s.front, s.back);
      }
      if (aiDeleteOriginal) {
        await deleteCard(card.card_id);
      }
      setStatus('AI cards created. Loading next card…');
      await loadNext(deckId);
      await refresh();
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiApplying(false);
    }
  };

  const aiPickedCount = aiSelected.filter(Boolean).length;

  const startEditing = () => {
    if (!card) return;
    setEditFront(htmlToText(card.front_html));
    setEditBack(htmlToText(card.back_html));
    setEditError(null);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!card) return;
    setEditError(null);
    if (!editFront.trim() || !editBack.trim()) {
      setEditError('Question and answer must be non-empty.');
      return;
    }
    setEditBusy(true);
    try {
      const updated = await updateCard(card.card_id, editFront, editBack);
      setCard({ ...card, front_html: updated.front_html, back_html: updated.back_html });
      setEditing(false);
      // Suggestions (if any) were for the old wording.
      setAiOpen(false);
      setAiSuggestions([]);
      setAiSelected([]);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };

  const scoped = deckId ? decks.find((d) => d.id === deckId) : undefined;
  const dueToday = scoped
    ? (scoped.due_today ?? 0)
    : decks.reduce((n, d) => n + (d.due_today ?? 0), 0);

  return (
    <Box>
      <DeckSelect decks={decks} value={deckId} onChange={setDeckId} allowAll label="Deck" />
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        {dueToday} due today
      </Typography>
      {decksError && <Alert severity="error">Could not load decks: {decksError}</Alert>}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {loading && <CircularProgress aria-label="loading next card" />}
      {!loading && !card && (
        <Typography color="text.secondary">Nothing due — nice work.</Typography>
      )}
      {card && (
        <Paper sx={{ p: 3, mt: 1 }}>
          <Box
            sx={{ ...qaTextSx, minHeight: 80 }}
            dangerouslySetInnerHTML={{ __html: card.front_html }}
          />
          {showBack && (
            <Box
              sx={{ ...qaTextSx, mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}
              dangerouslySetInnerHTML={{ __html: card.back_html }}
            />
          )}
          {!showBack ? (
            <Button variant="contained" sx={{ mt: 2 }} onClick={() => setShowBack(true)}>
              Show answer
            </Button>
          ) : (
            <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
              {(
                [
                  [1, 'Again', 'outlined'],
                  [2, 'Hard', 'outlined'],
                  [3, 'Good', 'contained'],
                  [4, 'Easy', 'outlined'],
                ] as Array<[number, string, 'outlined' | 'contained']>
              ).map(([rating, label, variant]) => (
                <Box
                  key={rating}
                  sx={{ display: 'flex', flexDirection: 'column', minWidth: 64 }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ textAlign: 'center', mb: 0.5 }}
                  >
                    {fmtInterval(card.intervals?.[String(rating)]) || ' '}
                  </Typography>
                  <Button variant={variant} onClick={() => grade(rating)}>
                    {label}
                  </Button>
                </Box>
              ))}
            </Box>
          )}
          {status && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {status}
            </Typography>
          )}
          <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              onClick={startAiReview}
              disabled={aiLoading || aiApplying || editing}
            >
              AI review
            </Button>
            <Button
              variant="outlined"
              onClick={startEditing}
              disabled={editing || aiLoading}
            >
              Edit
            </Button>
          </Box>
          {editing && (
            <Box sx={{ mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}>
              <Typography variant="subtitle1" gutterBottom>
                Edit card
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextField
                  label="Question"
                  multiline
                  minRows={3}
                  value={editFront}
                  onChange={(e) => setEditFront(e.target.value)}
                />
                <TextField
                  label="Answer"
                  multiline
                  minRows={3}
                  value={editBack}
                  onChange={(e) => setEditBack(e.target.value)}
                />
              </Box>
              {editError && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {editError}
                </Alert>
              )}
              <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                <Button onClick={() => setEditing(false)} disabled={editBusy}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={saveEdit}
                  disabled={editBusy}
                >
                  {editBusy ? 'Saving…' : 'Save'}
                </Button>
              </Box>
            </Box>
          )}
          {aiOpen && (
            <Box sx={{ mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}>
              <Typography variant="subtitle1" gutterBottom>
                AI review
                {aiLoading && (
                  <Typography
                    component="span"
                    variant="body2"
                    color="text.secondary"
                    sx={{ ml: 1 }}
                  >
                    in progress… {(aiElapsed / 1000).toFixed(1)}s
                  </Typography>
                )}
                {!aiLoading && aiMs !== null && (
                  <Typography
                    component="span"
                    variant="body2"
                    color="text.secondary"
                    sx={{ ml: 1 }}
                  >
                    took {(aiMs / 1000).toFixed(1)}s
                  </Typography>
                )}
              </Typography>
              {aiLoading && <CircularProgress aria-label="loading AI suggestions" />}
              {aiError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {aiError}
                </Alert>
              )}
              {!aiLoading && !aiError && aiSuggestions.length === 0 && (
                <Alert severity="success">
                  No changes suggested — the AI concluded this card already tests
                  a single fact.
                </Alert>
              )}
              {!aiLoading &&
                aiSuggestions.map((s, i) => (
                  <Paper key={i} variant="outlined" sx={{ p: 2, mb: 1 }}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={aiSelected[i] ?? false}
                          onChange={() => toggleAi(i)}
                        />
                      }
                      label={`Card ${i + 1}`}
                    />
                    <Typography variant="subtitle2">Q: {s.front}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      A: {s.back}
                    </Typography>
                  </Paper>
                ))}
              {!aiLoading && !aiError && aiSuggestions.length > 0 && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={aiDeleteOriginal}
                      onChange={(e) => setAiDeleteOriginal(e.target.checked)}
                    />
                  }
                  label="Delete the original card"
                />
              )}
              {!aiLoading && (
                <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                  <Button onClick={() => setAiOpen(false)} disabled={aiApplying}>
                    Cancel
                  </Button>
                  {aiSuggestions.length > 0 && (
                    <Button
                      variant="contained"
                      onClick={applyAi}
                      disabled={aiApplying || aiPickedCount === 0}
                    >
                      {aiApplying
                        ? 'Saving…'
                        : `Create ${aiPickedCount} card${aiPickedCount === 1 ? '' : 's'}`}
                    </Button>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
}

function BrowseView() {
  const { decks } = useDecks();
  const [deckId, setDeckId] = useState('');
  const [rows, setRows] = useState<BrowseCard[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [committedQ, setCommittedQ] = useState('');
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ deckId, q: '', loading: false, total: Infinity as number });
  stateRef.current = {
    deckId,
    q: committedQ,
    loading,
    total: rows.length >= total && total > 0 ? total : (Number.isFinite(stateRef.current.total) ? stateRef.current.total : Infinity),
  };

  useEffect(() => {
    if (decks.length > 0 && !deckId) {
      setDeckId(decks[0].id);
    }
  }, [decks, deckId]);

  // Debounce the search box into a server-side query.
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQ(q.trim()), 350);
    return () => clearTimeout(timer);
  }, [q]);

  // Reset paging whenever the deck or committed search changes.
  // Always due-date ascending: due-today rows lead the table.
  useEffect(() => {
    setRows([]);
    setTotal(0);
    stateRef.current.total = Infinity;
    if (!deckId) return;
    let cancelled = false;
    setLoading(true);
    browseCards(deckId, 'due', 'asc', 0, BROWSE_PAGE, committedQ)
      .then(({ cards, total: t }) => {
        if (cancelled) return;
        setRows(cards);
        setTotal(t);
        stateRef.current.total = cards.length < BROWSE_PAGE ? cards.length : t;
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deckId, committedQ]);

  // Infinite scroll: load the next page when the sentinel appears.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    let stopped = false;
    const loadMore = async () => {
      const s = stateRef.current;
      if (s.loading || !s.deckId) return;
      if (Number.isFinite(s.total) && rows.length >= (s.total as number)) return;
      if (rows.length === 0) return;
      stateRef.current.loading = true;
      setLoading(true);
      try {
        const { cards, total: t } = await browseCards(
          s.deckId,
          'due',
          'asc',
          rows.length,
          BROWSE_PAGE,
          s.q,
        );
        if (stopped) return;
        setRows((prev) => [...prev, ...cards]);
        setTotal(t);
        if (cards.length < BROWSE_PAGE) stateRef.current.total = rows.length + cards.length;
        else stateRef.current.total = t;
      } catch {
        if (!stopped) stateRef.current.total = rows.length;
      } finally {
        if (!stopped) {
          stateRef.current.loading = false;
          setLoading(false);
        }
      }
    };
    let observer: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      });
      observer.observe(el);
    }
    const onScroll = () => {
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 400) {
        void loadMore();
      }
    };
    window.addEventListener('scroll', onScroll);
    return () => {
      stopped = true;
      observer?.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [rows.length]);

  // While the user is still typing (server query not yet committed),
  // filter the already-loaded rows instantly; the debounced server
  // search then replaces them with full database results.
  const searching = q.trim() !== committedQ;
  const visibleRows =
    searching && q.trim()
      ? rows.filter((r) =>
          r.front_text.toLowerCase().includes(q.trim().toLowerCase()),
        )
      : rows;

  // Green divider between due-today rows (top) and everything else.
  // The table is always due-date ascending, so due-today rows lead.
  const splitIdx = visibleRows.findIndex((r) => !r.due_today);

  return (
    <Box>
      <FormControl fullWidth size="small" sx={{ mb: 1 }}>
        <InputLabel id="browse-deck-label">Deck</InputLabel>
        <Select
          labelId="browse-deck-label"
          label="Deck"
          value={deckId}
          onChange={(e) => setDeckId(e.target.value as string)}
        >
          {decks.map((d) => (
            <MenuItem key={d.id} value={d.id}>
              {d.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        label="Search cards"
        size="small"
        fullWidth
        sx={{ mb: 1 }}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        slotProps={{
          input: {
            endAdornment: searching ? (
              <CircularProgress size={16} aria-label="searching cards" />
            ) : undefined,
          },
        }}
      />
      <TableContainer sx={{ overflowX: 'hidden' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '2.5rem', textAlign: 'right' }}>#</TableCell>
              <TableCell>Question</TableCell>
              <TableCell sx={{ width: '8.5rem', fontWeight: 'bold' }}>Due</TableCell>
              <TableCell sx={{ width: '8.5rem', fontWeight: 'bold' }}>
                Last reviewed
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleRows.map((r, i) => (
              <Fragment key={r.card_id}>
                {i === splitIdx && splitIdx > 0 && (
                  <TableRow data-testid="due-divider">
                    <TableCell colSpan={4} sx={{ p: 0, borderBottom: 'none' }}>
                      <Box
                        sx={{
                          borderTop: '3px solid',
                          borderColor: 'success.main',
                        }}
                      />
                    </TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell sx={{ textAlign: 'right' }}>{i + 1}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}>
                    {r.front_text}
                  </TableCell>
                  <TableCell>{fmtDate(r.due)}</TableCell>
                  <TableCell>{fmtDate(r.last_review)}</TableCell>
                </TableRow>
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {loading && (
        <Box sx={{ textAlign: 'center', py: 1 }}>
          <CircularProgress size={20} aria-label="loading more cards" />
        </Box>
      )}
      <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
    </Box>
  );
}

function AddView() {
  const { decks } = useDecks();
  const [deckId, setDeckId] = useState('');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (decks.length > 0 && !deckId) {
      setDeckId(decks[0].id);
    }
  }, [decks, deckId]);

  const submit = async () => {
    setFeedback(null);
    setError(null);
    if (!deckId) {
      setError('Choose a deck first.');
      return;
    }
    if (!front.trim() || !back.trim()) {
      setError('Question and answer must be non-empty.');
      return;
    }
    setBusy(true);
    try {
      await createCard(deckId, front, back);
      setFeedback('Card added.');
      setFront('');
      setBack('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <DeckSelect decks={decks} value={deckId} onChange={setDeckId} label="Deck" />
      <TextField
        label="Question"
        multiline
        minRows={3}
        value={front}
        onChange={(e) => setFront(e.target.value)}
      />
      <TextField
        label="Answer"
        multiline
        minRows={3}
        value={back}
        onChange={(e) => setBack(e.target.value)}
      />
      <Box>
        <Button variant="contained" disabled={busy} onClick={submit}>
          Add card
        </Button>
      </Box>
      {feedback && <Alert severity="success">{feedback}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </Box>
  );
}

function stageLabel(stage: string): string {
  if (stage === 'parse') return 'Reading cards';
  if (stage === 'save') return 'Saving cards';
  return 'Uploading';
}

function ImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const submit = async () => {
    setResult(null);
    setError(null);
    setProgress(null);
    if (!file) {
      setError('Choose a .apkg or .colpkg file first.');
      return;
    }
    setBusy(true);
    try {
      const r = await importPackageStream(file, setProgress);
      let msg = `${r.imported} cards imported, ${r.due} due now.`;
      msg += r.scheduling
        ? ' Anki schedule kept.'
        : " No scheduling in file — re-export with 'Include scheduling information' to keep due dates.";
      setResult(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const determinate = progress !== null && progress.total > 1;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Button variant="outlined" component="label" disabled={busy}>
        {file ? file.name : 'Choose .apkg / .colpkg file'}
        <input
          type="file"
          accept=".apkg,.colpkg"
          hidden
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Button>
      <Box>
        <Button variant="contained" disabled={busy} onClick={submit}>
          Import
        </Button>
      </Box>
      {busy && (
        <Box>
          <Typography color="text.secondary" sx={{ mb: 1 }}>
            {progress
              ? `${stageLabel(progress.stage)} — ${progress.done} of ${progress.total} cards…`
              : 'Uploading…'}
          </Typography>
          <LinearProgress
            variant={determinate ? 'determinate' : 'indeterminate'}
            value={
              progress && progress.total > 1
                ? (100 * progress.done) / progress.total
                : undefined
            }
          />
        </Box>
      )}
      {result && <Alert severity="success">{result}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </Box>
  );
}

function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStats().then(setStats, (e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }
  if (!stats) {
    return <Typography color="text.secondary">Loading stats…</Typography>;
  }
  const maxDue = Math.max(1, ...stats.forecast.map((f) => f.due));
  const cards: Array<[string, string]> = [
    ['Due now', String(stats.totals.due)],
    ['New cards left', String(stats.totals.new)],
    ['Learning', String(stats.totals.learning)],
    ['Studied today', String(stats.today.studied)],
    [
      'Accuracy today',
      stats.today.accuracy === null ? '—' : `${stats.today.accuracy}%`,
    ],
    ['Total cards', String(stats.totals.cards)],
  ];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        {cards.map(([label, value]) => (
          <Paper key={label} sx={{ p: 2, minWidth: 140, flex: '1 1 140px' }}>
            <Typography variant="h5">{value}</Typography>
            <Typography color="text.secondary">{label}</Typography>
          </Paper>
        ))}
      </Box>
      <Typography variant="h6">Due forecast</Typography>
      {stats.forecast.map((f) => (
        <Box key={f.date} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography sx={{ width: 104, flexShrink: 0 }}>{fmtDate(f.date)}</Typography>
          <LinearProgress
            variant="determinate"
            value={(100 * f.due) / maxDue}
            sx={{ flexGrow: 1 }}
          />
          <Typography sx={{ width: 48, textAlign: 'right' }}>{f.due}</Typography>
        </Box>
      ))}
    </Box>
  );
}
