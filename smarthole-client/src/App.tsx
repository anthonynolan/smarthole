import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  Drawer,
  FormControl,
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
import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';
import {
  BROWSE_PAGE,
  browseCards,
  createCard,
  fmtDate,
  getDecks,
  getMe,
  getNext,
  getStats,
  googleLogin,
  gradeCard,
  importPackage,
  loadConfig,
  login,
  logout,
  register,
  type BrowseCard,
  type BrowseDir,
  type BrowseSort,
  type Deck,
  type ReviewCard,
  type Stats,
} from './api';

type View = 'review' | 'browse' | 'add' | 'import' | 'stats';

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
  if (clientId) {
    return <GoogleOAuthProvider clientId={clientId}>{shell}</GoogleOAuthProvider>;
  }
  return shell;
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
  useEffect(() => {
    let cancelled = false;
    getDecks()
      .then((d) => {
        if (!cancelled) setDecks(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { decks, error };
}

function ReviewView() {
  const { decks, error: decksError } = useDecks();
  const [deckId, setDeckId] = useState('');
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [showBack, setShowBack] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadNext = useCallback(async (deck: string) => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const cards = await getNext(deck as '');
      setCard(cards[0] ?? null);
      setShowBack(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNext(deckId);
  }, [deckId, loadNext]);

  const grade = async (rating: number) => {
    if (!card) return;
    setError(null);
    try {
      await gradeCard(card.card_id, rating);
      setStatus('Graded. Loading next card…');
      await loadNext(deckId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Box>
      <DeckSelect decks={decks} value={deckId} onChange={setDeckId} allowAll label="Deck" />
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
            sx={{ minHeight: 80 }}
            dangerouslySetInnerHTML={{ __html: card.front_html }}
          />
          {showBack && (
            <Box
              sx={{ mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}
              dangerouslySetInnerHTML={{ __html: card.back_html }}
            />
          )}
          {!showBack ? (
            <Button variant="contained" sx={{ mt: 2 }} onClick={() => setShowBack(true)}>
              Show answer
            </Button>
          ) : (
            <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
              <Button variant="outlined" onClick={() => grade(1)}>
                Again
              </Button>
              <Button variant="outlined" onClick={() => grade(2)}>
                Hard
              </Button>
              <Button variant="contained" onClick={() => grade(3)}>
                Good
              </Button>
              <Button variant="outlined" onClick={() => grade(4)}>
                Easy
              </Button>
            </Box>
          )}
          {status && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {status}
            </Typography>
          )}
        </Paper>
      )}
    </Box>
  );
}

function BrowseView() {
  const { decks } = useDecks();
  const [deckId, setDeckId] = useState('');
  const [sort, setSort] = useState<BrowseSort>('due');
  const [dir, setDir] = useState<BrowseDir>('asc');
  const [rows, setRows] = useState<BrowseCard[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ deckId, sort, dir, loading: false, total: Infinity as number });
  stateRef.current = {
    deckId,
    sort,
    dir,
    loading,
    total: rows.length >= total && total > 0 ? total : (Number.isFinite(stateRef.current.total) ? stateRef.current.total : Infinity),
  };

  useEffect(() => {
    if (decks.length > 0 && !deckId) {
      setDeckId(decks[0].id);
    }
  }, [decks, deckId]);

  // Reset paging whenever the deck or sort changes.
  useEffect(() => {
    setRows([]);
    setTotal(0);
    stateRef.current.total = Infinity;
    if (!deckId) return;
    let cancelled = false;
    setLoading(true);
    browseCards(deckId, sort, dir, 0, BROWSE_PAGE)
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
  }, [deckId, sort, dir]);

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
          s.sort,
          s.dir,
          rows.length,
          BROWSE_PAGE,
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

  const toggleSort = (key: BrowseSort) => {
    if (sort === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      setDir('asc');
    }
  };

  const arrow = (key: BrowseSort) =>
    sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : '';

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
      <TableContainer sx={{ overflowX: 'hidden' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '2.5rem', textAlign: 'right' }}>#</TableCell>
              <TableCell>Question</TableCell>
              <TableCell sx={{ width: '8.5rem' }}>
                <Button
                  variant="text"
                  size="small"
                  onClick={() => toggleSort('due')}
                  sx={{ p: 0, minWidth: 0, fontWeight: 'bold', color: 'inherit' }}
                >
                  Due{arrow('due')}
                </Button>
              </TableCell>
              <TableCell sx={{ width: '8.5rem' }}>
                <Button
                  variant="text"
                  size="small"
                  onClick={() => toggleSort('last_review')}
                  sx={{ p: 0, minWidth: 0, fontWeight: 'bold', color: 'inherit' }}
                >
                  Last reviewed{arrow('last_review')}
                </Button>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.card_id}>
                <TableCell sx={{ textAlign: 'right' }}>{i + 1}</TableCell>
                <TableCell sx={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}>
                  {r.front_text}
                </TableCell>
                <TableCell>{fmtDate(r.due)}</TableCell>
                <TableCell>{fmtDate(r.last_review)}</TableCell>
              </TableRow>
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

function ImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setResult(null);
    setError(null);
    if (!file) {
      setError('Choose a .apkg or .colpkg file first.');
      return;
    }
    setBusy(true);
    try {
      const r = await importPackage(file);
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
          <Typography sx={{ width: 90, flexShrink: 0 }}>{f.date.slice(5)}</Typography>
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
