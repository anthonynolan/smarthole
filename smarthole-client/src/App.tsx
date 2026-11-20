import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
  Radio,
  RadioGroup,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { createTheme, ThemeProvider, type SxProps, type Theme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';
import {
  BROWSE_PAGE,
  browseCards,
  createCard,
  deleteCard,
  fmtDate,
  fmtDateTime,
  fmtInterval,
  getCard,
  getDecks,
  getMe,
  getNext,
  getRelated,
  getStats,
  googleLogin,
  gradeCard,
  importPackageStream,
  type ImportProgress,
  loadConfig,
  login,
  logout,
  register,
  requestAiReviewStream,
  restoreCard,
  setCardDue,
  suspendCard,
  unsuspendCard,
  exportDecks,
  exportFeedback,
  getAllFeedback,
  getBuildInfo,
  getOwnFeedback,
  setFeedbackStatus,
  submitFeedback,
  updateCard,
  htmlToText,
  UI_BUILD_AT,
  type AiReviewMode,
  type AiReviewStatus,
  type AiSuggestion,
  type BrowseCard,
  type BrowseDir,
  type BrowseSort,
  type BuildInfo,
  type CardMeta,
  type Deck,
  type FeedbackItem,
  type FeedbackStatus,
  type RelatedCard,
  type ReviewCard,
  type Stats,
} from './api';

type View = 'review' | 'browse' | 'add' | 'import' | 'stats' | 'feedback';

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

/** Long-form study text: larger serif with generous leading and measure.
 *  Lora (loaded from Google Fonts in index.html) with a Georgia fallback
 *  when offline. */
const qaTextSx = {
  fontFamily: ['Lora', 'Georgia', '"Times New Roman"', 'Charter', 'serif'].join(', '),
  fontSize: '1.3rem',
  lineHeight: 1.75,
  maxWidth: '68ch',
  overflowWrap: 'break-word' as const,
  // Preserve authored line breaks (older cards store bare newlines).
  whiteSpace: 'pre-wrap' as const,
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
          <Button
            color="inherit"
            onClick={() => {
              setView('feedback');
              setDrawerOpen(false);
            }}
          >
            Feedback
          </Button>
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
            <ListItemText primary="Import/Export" />
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
          <ListItemButton
            selected={view === 'feedback'}
            onClick={() => {
              setView('feedback');
              setDrawerOpen(false);
            }}
          >
            <ListItemText primary="Feedback" />
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
        {view === 'feedback' && <FeedbackView />}
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

/** Card body HTML with every link forced into a new browser tab.
 * Stored HTML from older imports has no `target`, so it is enforced here at
 * render time (covering middle-clicks too) while plain left-clicks are
 * routed through `window.open` so the review page is never navigated away.
 */
function CardHtml({ html, sx }: { html: string; sx?: SxProps<Theme> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  }, [html]);
  const openLink = (e: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  return (
    <Box ref={ref} sx={sx} onClick={openLink} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** All stored metadata for one card, to troubleshoot data/system issues. */
function CardMetaView({ meta, card }: { meta: CardMeta | null; card: ReviewCard }) {
  const rows: Array<[string, string]> = meta
    ? [
        ['Card ID', meta.card_id],
        ['Deck', `${meta.deck_name} (${meta.deck_id})`],
        ['Created', fmtDate(meta.created_at ?? null)],
        ['Suspended', String(meta.suspended)],
        ['Deleted', meta.deleted ? `yes (at ${fmtDate(meta.deleted_at ?? null)})` : 'no'],
        ['New position', String(meta.new_position)],
        ['Anki note / ord', `${meta.anki_nid ?? '—'} / ${meta.anki_ord ?? '—'}`],
        ['Anki GUID', meta.anki_guid ?? '—'],
        ['Due', fmtDate(meta.due ?? null)],
        ['Last review', fmtDate(meta.last_review ?? null)],
        ['FSRS state', String(meta.state)],
        ['Step', String(meta.step)],
        ['Stability', meta.stability == null ? '—' : String(meta.stability)],
        ['Difficulty', meta.difficulty == null ? '—' : String(meta.difficulty)],
        ['Reps', String(meta.reps)],
        ['Lapses', String(meta.lapses)],
        ['Introduced', fmtDate(meta.introduced_at ?? null)],
      ]
    : [
        ['Card ID', card.card_id],
        ['Deck', card.deck_id],
        ['Created', fmtDate(card.created_at ?? null)],
        ['Due', fmtDate(card.due)],
        ['State', String(card.state)],
        ['Reps', String(card.reps)],
      ];
  return (
    <Box sx={{ mt: 2 }} data-testid="card-metadata">
      <Typography variant="subtitle2" gutterBottom>
        Card metadata
      </Typography>
      <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableCell sx={{ width: '12rem', color: 'text.secondary' }}>{label}</TableCell>
              <TableCell sx={{ overflowWrap: 'break-word' }}>{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
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
  const [aiMode, setAiMode] = useState<AiReviewMode>('split');
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiStarted, setAiStarted] = useState(false);
  const [aiStreamed, setAiStreamed] = useState('');
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiSelected, setAiSelected] = useState<boolean[]>([]);
  const [aiDeleteOriginal, setAiDeleteOriginal] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [aiMs, setAiMs] = useState<number | null>(null);
  const [aiElapsed, setAiElapsed] = useState(0);
  const [aiStatus, setAiStatus] = useState<AiReviewStatus | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const [preloaded, setPreloaded] = useState<ReviewCard | null>(null);
  const [editing, setEditing] = useState(false);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [related, setRelated] = useState<RelatedCard[]>([]);
  const [queued, setQueued] = useState<ReviewCard | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [studiedToday, setStudiedToday] = useState<number | null>(null);

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

  const refreshStudied = useCallback(async () => {
    try {
      const s = await getStats();
      setStudiedToday(s.today.studied);
    } catch {
      setStudiedToday(null);
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
    setAiMode('split');
    setAiQuestion('');
    setAiStarted(false);
    setAiStreamed('');
    setAiAnswer(null);
    setAiSuggestions([]);
    setAiSelected([]);
    setAiError(null);
    setAiMs(null);
    setAiStatus(null);
    setAiModel(null);
    setConfirmDelete(false);
    setDeleteError(null);
    setRelated([]);
    setQueued(null);
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
    void refreshStudied();
  }, [deckId, loadNext, refreshStudied]);

  // Similarity hint: closest related card across the whole database.
  // Runs in the background; hides itself when embeddings are unavailable.
  const relatedFor = card?.card_id ?? null;
  useEffect(() => {
    if (!relatedFor) {
      setRelated([]);
      return;
    }
    let cancelled = false;
    getRelated(relatedFor)
      .then((r) => {
        if (!cancelled) setRelated(r.cards ?? []);
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [relatedFor]);

  const grade = async (rating: number) => {
    if (!card) return;
    setError(null);
    try {
      await gradeCard(card.card_id, rating);
      const upNext = queued && queued.card_id !== card.card_id ? queued : null;
      if (upNext) {
        // A related card was queued: it goes next, ahead of the preload.
        setQueued(null);
        setPreloaded(null);
        setCard(upNext);
        setShowBack(false);
        setStatus(null);
        setRelated([]);
        void prefetchNext(deckId, upNext.card_id);
      } else if (preloaded && preloaded.card_id !== card.card_id) {
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
      await refreshStudied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const queueRelated = async () => {
    if (!related.length || queueBusy) return;
    setQueueBusy(true);
    setError(null);
    try {
      const full = await getCard(related[0].card_id);
      setQueued(full);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setQueueBusy(false);
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

  const openAiReview = () => {
    if (!card || aiLoading) return;
    setAiOpen(true);
    setAiStarted(false);
    setAiStreamed('');
    setAiAnswer(null);
    setAiError(null);
    setAiSuggestions([]);
    setAiSelected([]);
    setAiMs(null);
    setAiStatus(null);
    setAiModel(null);
  };

  const runAiReview = async () => {
    if (!card || aiLoading) return;
    if (aiMode === 'custom' && !aiQuestion.trim()) {
      setAiError('Type a question first.');
      return;
    }
    setAiStarted(true);
    setAiLoading(true);
    setAiError(null);
    setAiStreamed('');
    setAiAnswer(null);
    setAiSuggestions([]);
    setAiSelected([]);
    setAiMs(null);
    setAiStatus(null);
    setAiModel(null);
    const t0 = Date.now();
    try {
      const r = await requestAiReviewStream(
        card.card_id,
        aiMode === 'custom' ? { mode: 'custom', question: aiQuestion.trim() } : { mode: 'split' },
        (text) => setAiStreamed(text),
        (status) => setAiStatus(status),
      );
      setAiSuggestions(r.suggestions);
      setAiSelected(r.suggestions.map(() => true));
      setAiAnswer(r.answer);
      setAiModel(r.model || null);
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
    if (!card || aiApplying) return;
    const currentId = card.card_id;
    const deckOfCard = card.deck_id;
    const picked = aiSuggestions.filter((_, i) => aiSelected[i]);
    const removeOriginal = aiDeleteOriginal;
    setAiError(null);
    setAiApplying(true);
    // Move on immediately: close the dialog and queue the next card
    // (excluding this one) while the creates + delete land in the
    // background, so there is no UI wait on the writes.
    setAiOpen(false);
    setAiStarted(false);
    setAiStreamed('');
    setAiApplying(false);
    setCard(null);
    setShowBack(false);
    setStatus(
      picked.length
        ? `Creating ${picked.length} card${picked.length === 1 ? '' : 's'}…`
        : 'Loading next card…',
    );
    try {
      const next = await getNext(deckId as '', currentId);
      const upNext = next[0] ?? null;
      if (upNext) {
        setCard(upNext);
        setStatus(null);
        void prefetchNext(deckId, upNext.card_id);
      } else {
        await loadNext(deckId);
      }
      await refresh();
      await refreshStudied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void (async () => {
      try {
        for (const s of picked) {
          await createCard(deckOfCard, s.front, s.back);
        }
        if (removeOriginal) {
          await deleteCard(currentId);
        }
        await refresh();
        await refreshStudied();
      } catch (e) {
        setStatus(
          `Next card loaded, but saving the split failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
  };

  const aiPickedCount = aiSelected.filter(Boolean).length;

  const confirmDeleteCard = async () => {
    if (!card || deleteBusy) return;
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await deleteCard(card.card_id);
      setConfirmDelete(false);
      await loadNext(deckId);
      await refresh();
      setStatus('Card deleted.');
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

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
      setAiStarted(false);
      setAiStreamed('');
      setAiAnswer(null);
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
        {studiedToday !== null && ` · ${studiedToday} studied today`}
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
          {card.created_at && (
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
              Created {fmtDate(card.created_at)}
            </Typography>
          )}
          <CardHtml html={card.front_html} sx={{ ...qaTextSx, minHeight: 80 }} />
          {showBack && (
            <CardHtml
              html={card.back_html}
              sx={{ ...qaTextSx, mt: 0, pt: 1, borderTop: '1px dashed #aaa' }}
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
          {related.length > 0 && !queued && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1 }}
              data-testid="related-hint"
            >
              Related:{' '}
              <Button
                variant="text"
                size="small"
                onClick={queueRelated}
                disabled={queueBusy}
                sx={{
                  textTransform: 'none',
                  p: 0,
                  minWidth: 0,
                  verticalAlign: 'baseline',
                  fontSize: 'inherit',
                }}
              >
                {related[0].front_text}
              </Button>
              {related[0].deck_name ? ` (${related[0].deck_name})` : ''}
            </Typography>
          )}
          {queued && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1 }}
              data-testid="queued-next"
            >
              Up next: {htmlToText(queued.front_html).slice(0, 80)}{' '}
              <Button
                variant="text"
                size="small"
                onClick={() => setQueued(null)}
                sx={{
                  textTransform: 'none',
                  p: 0,
                  minWidth: 0,
                  verticalAlign: 'baseline',
                  fontSize: 'inherit',
                }}
              >
                Clear
              </Button>
            </Typography>
          )}
          <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              onClick={openAiReview}
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
                  helperText="Plain text — blank lines become line breaks; **bold**, *italic*, `code`, [links](https://…) are rendered."
                />
                <TextField
                  label="Answer"
                  multiline
                  minRows={3}
                  value={editBack}
                  onChange={(e) => setEditBack(e.target.value)}
                  helperText="Plain text — blank lines become line breaks; **bold**, *italic*, `code`, [links](https://…) are rendered."
                />
              </Box>
              {editError && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {editError}
                </Alert>
              )}
              <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                <Button onClick={() => { setEditing(false); setConfirmDelete(false); }} disabled={editBusy}>
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
              <CardMetaView meta={card.meta ?? null} card={card} />
              <Box sx={{ mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}>
                <Typography variant="subtitle2" gutterBottom>
                  Delete this card?
                </Typography>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Deleting hides the card but keeps its scheduling state and
                  review history — restore it later from Browse's "Show
                  deleted" view.
                </Typography>
                {!confirmDelete ? (
                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => setConfirmDelete(true)}
                    disabled={deleteBusy}
                  >
                    Delete
                  </Button>
                ) : (
                  <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                    <Button onClick={() => setConfirmDelete(false)} disabled={deleteBusy}>
                      Keep card
                    </Button>
                    <Button
                      variant="contained"
                      color="error"
                      onClick={confirmDeleteCard}
                      disabled={deleteBusy}
                    >
                      {deleteBusy ? 'Deleting…' : 'Delete card'}
                    </Button>
                  </Box>
                )}
                {deleteError && (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    {deleteError}
                  </Alert>
                )}
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
              {(aiStatus || aiModel) && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="ai-meta">
                  {aiStatus && (
                    <span data-testid="ai-status">Status: {aiStatus}</span>
                  )}
                  {aiStatus && aiModel && ' · '}
                  {aiModel && (
                    <span data-testid="ai-model">Model: {aiModel}</span>
                  )}
                </Typography>
              )}
              {aiStarted && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="ai-selection">
                  {aiMode === 'split' ? 'Split this card' : 'Ask a question about this card'}
                  {aiMode === 'custom' && aiQuestion.trim() && `: “${aiQuestion.trim()}”`}
                </Typography>
              )}
              {!aiStarted && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <RadioGroup
                    aria-label="AI review option"
                    value={aiMode}
                    onChange={(e) => setAiMode(e.target.value as AiReviewMode)}
                  >
                    <FormControlLabel
                      value="split"
                      control={<Radio />}
                      label="Split this card"
                    />
                    <FormControlLabel
                      value="custom"
                      control={<Radio />}
                      label="Ask a question about this card"
                    />
                  </RadioGroup>
                  {aiMode === 'custom' && (
                    <TextField
                      label="Your question"
                      placeholder="is this card still valid?"
                      multiline
                      minRows={2}
                      value={aiQuestion}
                      onChange={(e) => setAiQuestion(e.target.value)}
                    />
                  )}
                  {aiError && (
                    <Alert severity="error" sx={{ mb: 0 }}>
                      {aiError}
                    </Alert>
                  )}
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button onClick={() => setAiOpen(false)}>Cancel</Button>
                    <Button
                      variant="contained"
                      onClick={runAiReview}
                      disabled={aiLoading || (aiMode === 'custom' && !aiQuestion.trim())}
                    >
                      Ask AI
                    </Button>
                  </Box>
                </Box>
              )}
              {aiStarted && aiLoading && (
                <CircularProgress aria-label="loading AI suggestions" />
              )}
              {aiStarted && aiError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {aiError}
                </Alert>
              )}
              {aiStarted && !aiLoading && !aiError && aiMode === 'custom' && (
                <Paper variant="outlined" sx={{ p: 2, mb: 1 }} data-testid="ai-answer">
                  <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
                    {aiAnswer}
                  </Typography>
                </Paper>
              )}
              {aiStarted &&
                !aiLoading &&
                !aiError &&
                aiMode === 'split' &&
                aiSuggestions.length === 0 && (
                  <Alert severity="success">
                    No changes suggested — the AI concluded this card already tests
                    a single fact.
                  </Alert>
                )}
              {aiStarted &&
                !aiLoading &&
                !aiError &&
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
              {aiStarted && !aiLoading && !aiError && aiSuggestions.length > 0 && (
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
              {aiStarted && !aiLoading && (
                <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                  <Button onClick={() => setAiOpen(false)} disabled={aiApplying}>
                    {aiMode === 'custom' || aiSuggestions.length === 0 ? 'Close' : 'Cancel'}
                  </Button>
                  {aiMode === 'split' && aiSuggestions.length > 0 && (
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

/** Last browse deck, so the first page can load in parallel with the deck list. */
const BROWSE_DECK_KEY = 'smarthole.browseDeckId';

/** ISO timestamp to a datetime-local input value (local time). */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function BrowseView() {
  const { decks } = useDecks();
  const [deckId, setDeckId] = useState(() => {
    try {
      return localStorage.getItem(BROWSE_DECK_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [rows, setRows] = useState<BrowseCard[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [committedQ, setCommittedQ] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [showMcpOnly, setShowMcpOnly] = useState(false);
  const [showSuspendedOnly, setShowSuspendedOnly] = useState(false);
  const [sort, setSort] = useState<BrowseSort>('due');
  const [direction, setDirection] = useState<BrowseDir>('asc');
  const isMobile = useMediaQuery('(max-width:600px)');
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewCard | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailEditFront, setDetailEditFront] = useState('');
  const [detailEditBack, setDetailEditBack] = useState('');
  const [detailEditBusy, setDetailEditBusy] = useState(false);
  const [detailEditError, setDetailEditError] = useState<string | null>(null);
  const [detailDue, setDetailDue] = useState('');
  const [detailSchedBusy, setDetailSchedBusy] = useState(false);
  const [detailSchedError, setDetailSchedError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ deckId, sort: 'due' as BrowseSort, direction: 'asc' as BrowseDir, q: '', showDeleted: false, showMcpOnly: false, showSuspendedOnly: false, loading: false, total: Infinity as number });
  stateRef.current = {
    deckId,
    sort,
    direction,
    q: committedQ,
    showDeleted,
    showMcpOnly,
    showSuspendedOnly,
    loading,
    total: rows.length >= total && total > 0 ? total : (Number.isFinite(stateRef.current.total) ? stateRef.current.total : Infinity),
  };

  // Remember the deck so the next visit can fetch its first page in
  // parallel with the deck list instead of waiting for it.
  useEffect(() => {
    if (!deckId) return;
    try {
      localStorage.setItem(BROWSE_DECK_KEY, deckId);
    } catch {
      // Private-mode storage: the deck just won't be remembered.
    }
  }, [deckId]);

  useEffect(() => {
    // A remembered deck may be gone (deleted on another device): fall back
    // to the first deck. The cards fetch for a stale id 404s harmlessly
    // and is replaced once the deck id resets here.
    if (decks.length > 0 && (!deckId || !decks.some((d) => d.id === deckId))) {
      setDeckId(decks[0].id);
    }
  }, [decks, deckId]);

  // Debounce the search box into a server-side query.
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQ(q.trim()), 350);
    return () => clearTimeout(timer);
  }, [q]);

  // Reset paging whenever the deck, sort, or committed search changes.
  // Default due-date ascending: due-today rows lead the table.
  useEffect(() => {
    setRows([]);
    setTotal(0);
    setSelected(new Set());
    stateRef.current.total = Infinity;
    if (!deckId) return;
    let cancelled = false;
    setLoading(true);
    setRowError(null);
    browseCards(deckId, sort, direction, 0, BROWSE_PAGE, committedQ, showDeleted, showMcpOnly, showSuspendedOnly)
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
  }, [deckId, sort, direction, committedQ, showDeleted, showMcpOnly, showSuspendedOnly]);

  const reloadBrowse = useCallback(async () => {
    if (!deckId) return;
    setLoading(true);
    setRowError(null);
    try {
      const { cards, total: t } = await browseCards(
        deckId, sort, direction, 0, BROWSE_PAGE, committedQ, showDeleted, showMcpOnly, showSuspendedOnly,
      );
      setRows(cards);
      setTotal(t);
    } finally {
      setLoading(false);
    }
  }, [deckId, sort, direction, committedQ, showDeleted, showMcpOnly, showSuspendedOnly]);

  const handleRestore = async (cardId: string) => {
    setRowError(null);
    setRowBusy(cardId);
    try {
      await restoreCard(cardId);
      setSelected((prev) => {
        if (!prev.has(cardId)) return prev;
        const next = new Set(prev);
        next.delete(cardId);
        return next;
      });
      await reloadBrowse();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(null);
    }
  };

  // Full detail for the clicked row, loaded on demand. Deleted cards
  // have no review payload (the endpoint 404s), so the dialog falls back
  // to the row's own summary fields in that case.
  const detailRow = detailId ? (rows.find((r) => r.card_id === detailId) ?? null) : null;
  useEffect(() => {
    if (!detailId) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setDetailEditing(false);
    setDetailDue('');
    setDetailSchedError(null);
    setDetailLoading(true);
    getCard(detailId)
      .then((c) => {
        if (cancelled) return;
        setDetail(c);
        setDetailDue(toLocalInput(c.due));
      })
      .catch(() => {
        if (!cancelled) setDetailError('Could not load the full card detail.');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  const startDetailEdit = () => {
    if (!detail) return;
    setDetailEditFront(htmlToText(detail.front_html));
    setDetailEditBack(htmlToText(detail.back_html));
    setDetailEditError(null);
    setDetailEditing(true);
  };

  const saveDetailEdit = async () => {
    if (!detail || !detailId) return;
    setDetailEditError(null);
    if (!detailEditFront.trim() || !detailEditBack.trim()) {
      setDetailEditError('Question and answer must be non-empty.');
      return;
    }
    setDetailEditBusy(true);
    try {
      await updateCard(detailId, detailEditFront, detailEditBack);
      setDetail(await getCard(detailId));
      setDetailEditing(false);
      await reloadBrowse();
    } catch (e) {
      setDetailEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailEditBusy(false);
    }
  };

  const toggleDetailSuspend = async () => {
    if (!detail || !detailId || detailSchedBusy) return;
    setDetailSchedError(null);
    setDetailSchedBusy(true);
    try {
      if (detail.meta?.suspended) {
        await unsuspendCard(detailId);
      } else {
        await suspendCard(detailId);
      }
      setDetail(await getCard(detailId));
      await reloadBrowse();
    } catch (e) {
      setDetailSchedError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailSchedBusy(false);
    }
  };

  const saveDetailDue = async () => {
    if (!detail || !detailId || detailSchedBusy || !detailDue) return;
    const parsed = new Date(detailDue);
    if (Number.isNaN(parsed.getTime())) {
      setDetailSchedError('Enter a valid date and time.');
      return;
    }
    setDetailSchedError(null);
    setDetailSchedBusy(true);
    try {
      await setCardDue(detailId, parsed.toISOString());
      const refreshed = await getCard(detailId);
      setDetail(refreshed);
      setDetailDue(toLocalInput(refreshed.due));
      await reloadBrowse();
    } catch (e) {
      setDetailSchedError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailSchedBusy(false);
    }
  };

  const handlePermanentDelete = async (cardId: string) => {
    if (!window.confirm('Permanently delete this card? Its schedule and review history are removed too. This cannot be undone.')) return;
    setRowError(null);
    setRowBusy(cardId);
    try {
      await deleteCard(cardId, true);
      setSelected((prev) => {
        if (!prev.has(cardId)) return prev;
        const next = new Set(prev);
        next.delete(cardId);
        return next;
      });
      await reloadBrowse();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(null);
    }
  };

  /** Delete every selected visible card behind a single confirm. */
  const handleBulkDelete = async (ids: string[], permanent: boolean) => {
    if (bulkBusy || ids.length === 0) return;
    const noun = ids.length === 1 ? '1 selected card' : `${ids.length} selected cards`;
    const ok = window.confirm(
      permanent
        ? `Permanently delete ${noun}? Their schedules and review histories are removed too. This cannot be undone.`
        : `Delete ${noun}? They stay restorable from "Show deleted".`,
    );
    if (!ok) return;
    setRowError(null);
    setBulkBusy(true);
    try {
      for (const id of ids) {
        await deleteCard(id, permanent);
      }
      setSelected(new Set());
      await reloadBrowse();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

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
          s.direction,
          rows.length,
          BROWSE_PAGE,
          s.q,
          s.showDeleted,
          s.showMcpOnly,
          s.showSuspendedOnly,
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
  const searchedRows =
    searching && q.trim()
      ? rows.filter((r) =>
          r.front_text.toLowerCase().includes(q.trim().toLowerCase()),
        )
      : rows;

  // Clicking a column heading sorts by it (again reverses direction).
  const toggleSort = (field: BrowseSort) => {
    if (sort === field) {
      setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setDirection('asc');
    }
  };

  // Green divider between due-today rows (top) and everything else. Only
  // for the default due-date-ascending sort: any other column order keeps
  // the server order untouched so the chosen sort is what you see.
  // Due-today rows are ordered first: the server sort is by due date, so
  // not-yet-due new cards (reps 0) can otherwise sit above due-today rows
  // and hide the divider.
  const defaultDueOrder = sort === 'due' && direction === 'asc';
  const visibleRows = showDeleted || !defaultDueOrder
    ? searchedRows
    : [...searchedRows].sort((a, b) => Number(b.due_today) - Number(a.due_today));
  const splitIdx = showDeleted || !defaultDueOrder ? -1 : visibleRows.findIndex((r) => !r.due_today);

  const toggleSelect = (cardId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  const selectedVisibleIds = visibleRows
    .filter((r) => selected.has(r.card_id))
    .map((r) => r.card_id);
  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.card_id));
  const someVisibleSelected = visibleRows.some((r) => selected.has(r.card_id));
  const toggleSelectAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (visibleRows.every((r) => prev.has(r.card_id))) {
        visibleRows.forEach((r) => next.delete(r.card_id));
      } else {
        visibleRows.forEach((r) => next.add(r.card_id));
      }
      return next;
    });

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
      <FormControlLabel
        control={
          <Checkbox
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
          />
        }
        label="Show deleted"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={showMcpOnly}
            onChange={(e) => setShowMcpOnly(e.target.checked)}
          />
        }
        label="Show MCP-created"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={showSuspendedOnly}
            onChange={(e) => setShowSuspendedOnly(e.target.checked)}
          />
        }
        label="Show suspended"
      />
      {showDeleted && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Deleted cards only — restore one, or permanently delete it (schedule
          and review history are removed only by permanent deletion).
        </Typography>
      )}
      {showMcpOnly && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          MCP-created cards only — cards added via the MCP call, verified with
          checkboxes before creation.
        </Typography>
      )}
      {showSuspendedOnly && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Suspended cards only — unsuspend a card from its card detail
          to return it to the review queue.
        </Typography>
      )}
      {rowError && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {rowError}
        </Alert>
      )}
      {selectedVisibleIds.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {selectedVisibleIds.length} selected
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color="error"
            onClick={() => void handleBulkDelete(selectedVisibleIds, showDeleted)}
            disabled={bulkBusy || rowBusy !== null}
          >
            {bulkBusy
              ? 'Deleting…'
              : showDeleted
                ? 'Delete selected forever'
                : 'Delete selected'}
          </Button>
          <Button size="small" onClick={() => setSelected(new Set())} disabled={bulkBusy}>
            Clear
          </Button>
        </Box>
      )}
      {isMobile && (
        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <FormControl size="small" sx={{ flexGrow: 1 }}>
            <InputLabel id="browse-sort-label">Sort by</InputLabel>
            <Select
              labelId="browse-sort-label"
              label="Sort by"
              value={sort}
              onChange={(e) => toggleSort(e.target.value as BrowseSort)}
            >
              <MenuItem value="due">Due</MenuItem>
              <MenuItem value="last_review">Last reviewed</MenuItem>
              <MenuItem value="created_at">Created</MenuItem>
              <MenuItem value="card_number">Card #</MenuItem>
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            size="small"
            aria-label={direction === 'asc' ? 'Sort ascending' : 'Sort descending'}
            onClick={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
          >
            {direction === 'asc' ? '↑' : '↓'}
          </Button>
        </Box>
      )}
      <TableContainer sx={{ overflowX: 'hidden', display: isMobile ? 'none' : undefined }}>
        <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '2.5rem' }} padding="checkbox">
                <Checkbox
                  inputProps={{ 'aria-label': 'Select all visible cards' }}
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected && !allVisibleSelected}
                  onChange={toggleSelectAll}
                  disabled={visibleRows.length === 0}
                />
              </TableCell>
              <TableCell sx={{ width: '2.5rem', textAlign: 'right' }} sortDirection={sort === 'card_number' ? direction : false}>
                <TableSortLabel
                  active={sort === 'card_number'}
                  direction={sort === 'card_number' ? direction : 'asc'}
                  onClick={() => toggleSort('card_number')}
                >
                  #
                </TableSortLabel>
              </TableCell>
              <TableCell>Question</TableCell>
              <TableCell sx={{ width: '8.5rem', fontWeight: 'bold' }} sortDirection={sort === 'due' ? direction : false}>
                <TableSortLabel
                  active={sort === 'due'}
                  direction={sort === 'due' ? direction : 'asc'}
                  onClick={() => toggleSort('due')}
                >
                  Due
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: '8.5rem', fontWeight: 'bold' }} sortDirection={sort === 'last_review' ? direction : false}>
                <TableSortLabel
                  active={sort === 'last_review'}
                  direction={sort === 'last_review' ? direction : 'asc'}
                  onClick={() => toggleSort('last_review')}
                >
                  Last reviewed
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: '8.5rem', fontWeight: 'bold' }} sortDirection={sort === 'created_at' ? direction : false}>
                <TableSortLabel
                  active={sort === 'created_at'}
                  direction={sort === 'created_at' ? direction : 'asc'}
                  onClick={() => toggleSort('created_at')}
                >
                  Created
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: '5rem', fontWeight: 'bold' }}>Susp.</TableCell>
              {showDeleted && (
                <TableCell sx={{ width: '12rem', fontWeight: 'bold' }}>Actions</TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleRows.map((r, i) => (
              <Fragment key={r.card_id}>
                {i === splitIdx && splitIdx > 0 && (
                  <TableRow data-testid="due-divider">
                    <TableCell colSpan={showDeleted ? 8 : 7} sx={{ p: 0, borderBottom: 'none', height: '3px' }}>
                      <Box
                        sx={{
                          borderTop: '3px solid',
                          borderColor: 'success.main',
                          minHeight: '3px',
                        }}
                      />
                    </TableCell>
                  </TableRow>
                )}
                <TableRow
                  hover
                  onClick={() => setDetailId(r.card_id)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      inputProps={{ 'aria-label': `Select card ${i + 1}` }}
                      checked={selected.has(r.card_id)}
                      onChange={() => toggleSelect(r.card_id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </TableCell>
                  <TableCell sx={{ textAlign: 'right' }}>{r.card_number ?? '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}>
                    {r.front_text}
                  </TableCell>
                  <TableCell>{fmtDate(r.due)}</TableCell>
                  <TableCell>{fmtDate(r.last_review)}</TableCell>
                  <TableCell>{fmtDate(r.created_at ?? null)}</TableCell>
                  <TableCell>{r.suspended ? 'Yes' : '—'}</TableCell>
                  {showDeleted && (
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRestore(r.card_id);
                          }}
                          disabled={rowBusy === r.card_id}
                        >
                          Restore
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="error"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handlePermanentDelete(r.card_id);
                          }}
                          disabled={rowBusy === r.card_id}
                        >
                          Delete forever
                        </Button>
                      </Box>
                    </TableCell>
                  )}
                </TableRow>
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {isMobile && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {visibleRows.map((r) => (
            <Paper
              key={r.card_id}
              onClick={() => setDetailId(r.card_id)}
              sx={{ p: 1.5, cursor: 'pointer' }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Checkbox
                  inputProps={{ 'aria-label': `Select card ${r.card_number ?? ''}` }}
                  checked={selected.has(r.card_id)}
                  onChange={() => toggleSelect(r.card_id)}
                  onClick={(e) => e.stopPropagation()}
                  size="small"
                  sx={{ p: 0.5 }}
                />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  #{r.card_number ?? '—'}
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                {r.suspended && (
                  <Typography variant="caption" color="text.secondary">
                    Suspended
                  </Typography>
                )}
              </Box>
              <Typography
                variant="body1"
                sx={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}
              >
                {r.front_text}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Due {fmtDate(r.due)} · Reviewed {fmtDate(r.last_review)} · Created{' '}
                {fmtDate(r.created_at ?? null)}
              </Typography>
              {showDeleted && (
                <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRestore(r.card_id);
                    }}
                    disabled={rowBusy === r.card_id}
                  >
                    Restore
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handlePermanentDelete(r.card_id);
                    }}
                    disabled={rowBusy === r.card_id}
                  >
                    Delete forever
                  </Button>
                </Box>
              )}
            </Paper>
          ))}
        </Box>
      )}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 1 }}>
          <CircularProgress size={20} aria-label="loading more cards" />
        </Box>
      )}
      <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
      <Dialog
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Card detail</DialogTitle>
        <DialogContent dividers data-testid="browse-detail">
          {detailLoading && (
            <Box sx={{ textAlign: 'center', py: 2 }}>
              <CircularProgress size={20} aria-label="loading card detail" />
            </Box>
          )}
          {detailError && !detail && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {detailError}
            </Alert>
          )}
          {detail ? (
            detailEditing ? (
              <>
                <TextField
                  label="Question"
                  multiline
                  fullWidth
                  minRows={2}
                  value={detailEditFront}
                  onChange={(e) => setDetailEditFront(e.target.value)}
                  disabled={detailEditBusy}
                  sx={{ mb: 2 }}
                />
                <TextField
                  label="Answer"
                  multiline
                  fullWidth
                  minRows={4}
                  value={detailEditBack}
                  onChange={(e) => setDetailEditBack(e.target.value)}
                  disabled={detailEditBusy}
                />
                {detailEditError && (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {detailEditError}
                  </Alert>
                )}
              </>
            ) : (
              <>
                <CardHtml html={detail.front_html} sx={qaTextSx} />
                <CardHtml
                  html={detail.back_html}
                  sx={{ ...qaTextSx, mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}
                />
                <CardMetaView meta={detail.meta} card={detail} />
                <Box sx={{ mt: 2, pt: 2, borderTop: '1px dashed #aaa' }}>
                  <Typography variant="subtitle2" gutterBottom>
                    Scheduling
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {detail.meta?.suspended
                      ? 'Suspended — hidden from the review queue.'
                      : 'In the review queue.'}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => void toggleDetailSuspend()}
                      disabled={detailSchedBusy}
                    >
                      {detail.meta?.suspended ? 'Unsuspend' : 'Suspend'}
                    </Button>
                  </Box>
                  <Box
                    sx={{
                      display: 'flex',
                      gap: 1,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <TextField
                      label="Due date"
                      type="datetime-local"
                      size="small"
                      value={detailDue}
                      onChange={(e) => setDetailDue(e.target.value)}
                      disabled={detailSchedBusy}
                      sx={{ minWidth: 220 }}
                    />
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => void saveDetailDue()}
                      disabled={detailSchedBusy || !detailDue}
                    >
                      Save due date
                    </Button>
                  </Box>
                  {detailSchedError && (
                    <Alert severity="error" sx={{ mt: 1 }}>
                      {detailSchedError}
                    </Alert>
                  )}
                </Box>
              </>
            )
          ) : (
            !detailLoading &&
            detailRow && (
              <>
                <Box sx={qaTextSx}>{detailRow.front_text}</Box>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Due {fmtDate(detailRow.due)} · Last reviewed{' '}
                  {fmtDate(detailRow.last_review)} · Created{' '}
                  {fmtDate(detailRow.created_at ?? null)}
                </Typography>
              </>
            )
          )}
        </DialogContent>
        <DialogActions>
          {detail && !detailEditing && <Button onClick={startDetailEdit}>Edit</Button>}
          {detailEditing && (
            <>
              <Button onClick={() => setDetailEditing(false)} disabled={detailEditBusy}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={() => void saveDetailEdit()}
                disabled={detailEditBusy}
              >
                Save
              </Button>
            </>
          )}
          <Button onClick={() => setDetailId(null)}>Close</Button>
        </DialogActions>
      </Dialog>
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
  const { decks } = useDecks();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [exportIds, setExportIds] = useState<Set<string>>(new Set());
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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

  const submitExport = async () => {
    setExportError(null);
    const ids = [...exportIds];
    if (ids.length === 0) {
      setExportError('Tick at least one deck to export.');
      return;
    }
    setExportBusy(true);
    try {
      await exportDecks(ids);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  };

  const toggleExportDeck = (id: string) =>
    setExportIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const determinate = progress !== null && progress.total > 1;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6">Import</Typography>
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
      <Typography variant="h6" sx={{ mt: 2 }}>
        Export
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Download one or more decks as a single .apkg file. Scheduling and
        media references are not carried over.
      </Typography>
      {decks.map((d) => (
        <FormControlLabel
          key={d.id}
          control={
            <Checkbox
              checked={exportIds.has(d.id)}
              onChange={() => toggleExportDeck(d.id)}
            />
          }
          label={`${d.name} (${d.total})`}
        />
      ))}
      <Box>
        <Button
          variant="contained"
          disabled={exportBusy || exportIds.size === 0}
          onClick={submitExport}
        >
          {exportBusy ? 'Exporting…' : 'Export .apkg'}
        </Button>
      </Box>
      {exportError && <Alert severity="error">{exportError}</Alert>}
    </Box>
  );
}

function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    getStats().then(setStats, (e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
    getBuildInfo().then(setBuildInfo, () => undefined);
  }, []);

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }
  if (!stats) {
    return <Typography color="text.secondary">Loading stats…</Typography>;
  }
  // Tomorrow leftmost: today's bar is the "Due now" card above.
  const forecast = stats.forecast.slice(1);
  const maxDue = Math.max(1, ...forecast.map((f) => f.due));
  const added = stats.added_per_day ?? [];
  const maxAdded = Math.max(1, ...added.map((d) => d.added));
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
      <Box
        data-testid="due-forecast-chart"
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '2px',
          height: 220,
          width: '100%',
          overflowX: 'hidden',
          pb: 1,
        }}
      >
        {forecast.map((f) => (
          <Box
            key={f.date}
            sx={{
              flex: '1 1 0',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              height: '100%',
            }}
            title={`${fmtDate(f.date)}: ${f.due} due`}
          >
            <Typography variant="caption" sx={{ fontSize: '0.65rem' }}>{f.due || ''}</Typography>
            <Box
              sx={{
                width: '60%',
                maxWidth: 16,
                height: `${Math.max(f.due > 0 ? 8 : 2, (f.due / maxDue) * 120)}px`,
                bgcolor: 'primary.main',
                borderRadius: '4px 4px 0 0',
              }}
            />
            <Typography
              color="text.secondary"
              sx={{
                writingMode: 'vertical-rl',
                fontSize: '0.6rem',
                lineHeight: 1,
                height: 64,
                mt: 0.5,
                whiteSpace: 'nowrap',
              }}
            >
              {fmtDate(f.date)}
            </Typography>
          </Box>
        ))}
      </Box>
      {added.length > 0 && (
        <>
          <Typography variant="h6">Cards added per day</Typography>
          <Box
            data-testid="added-per-day-chart"
            sx={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: '2px',
              height: 220,
              width: '100%',
              overflowX: 'hidden',
              pb: 1,
            }}
          >
            {added.map((d) => (
              <Box
                key={d.date}
                sx={{
                  flex: '1 1 0',
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  height: '100%',
                }}
                title={`${fmtDate(d.date)}: ${d.added} added`}
              >
                <Typography variant="caption" sx={{ fontSize: '0.65rem' }}>{d.added || ''}</Typography>
                <Box
                  sx={{
                    width: '60%',
                    maxWidth: 16,
                    height: `${Math.max(d.added > 0 ? 8 : 2, (d.added / maxAdded) * 120)}px`,
                    bgcolor: 'secondary.main',
                    borderRadius: '4px 4px 0 0',
                  }}
                />
                <Typography
                  color="text.secondary"
                  sx={{
                    writingMode: 'vertical-rl',
                    fontSize: '0.6rem',
                    lineHeight: 1,
                    height: 64,
                    mt: 0.5,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtDate(d.date)}
                </Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
      <Typography variant="caption" color="text.secondary" data-testid="build-info">
        {buildInfo
          ? `Server deployed ${fmtDateTime(buildInfo.server_started_at)}${buildInfo.server_git_sha ? ` (${buildInfo.server_git_sha})` : ''} · UI built ${fmtDateTime(UI_BUILD_AT)}`
          : `UI built ${fmtDateTime(UI_BUILD_AT)}`}
      </Typography>
    </Box>
  );
}

function FeedbackView() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<FeedbackItem[]>([]);
  // null = not an admin (GET /feedback/all 403s); otherwise everyone's list.
  const [all, setAll] = useState<FeedbackItem[] | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [committedEmail, setCommittedEmail] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);

  const speechSupported =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition,
    );

  useEffect(() => {
    getOwnFeedback().then(setMine, () => undefined);
    return () => {
      try {
        recRef.current?.stop();
      } catch {
        // Never mounted a recognizer: nothing to stop.
      }
    };
  }, []);

  // Debounce the admin email filter into a server-side query.
  useEffect(() => {
    const timer = setTimeout(() => setCommittedEmail(emailFilter.trim()), 350);
    return () => clearTimeout(timer);
  }, [emailFilter]);

  // Admin list (everyone's feedback): a 403 here just means a regular user.
  // Reloads whenever the admin filters change.
  useEffect(() => {
    let cancelled = false;
    getAllFeedback({
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(committedEmail ? { email: committedEmail } : {}),
    }).then(
      (items) => {
        if (cancelled) return;
        setAll(items);
        setAdminMode(true);
      },
      (e) => {
        if (cancelled) return;
        if (!adminMode) {
          setAdminMode(false);
          return;
        }
        setListError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [statusFilter, committedEmail]);

  const toggleListen = () => {
    if (listening) {
      try {
        recRef.current?.stop();
      } finally {
        setListening(false);
      }
      return;
    }
    const w = window as unknown as Record<string, any>;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      }
      if (finalText) setText((t) => (t ? `${t} ${finalText}` : finalText));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await submitFeedback(body, 'Feedback');
      setMine((prev) => [created, ...prev]);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (id: string, status: FeedbackStatus) => {
    setListError(null);
    try {
      const updated = await setFeedbackStatus(id, status);
      setAll((prev) => (prev ? prev.map((f) => (f.id === id ? updated : f)) : prev));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  };

  const doExport = async () => {
    setExportBusy(true);
    setListError(null);
    try {
      await exportFeedback({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(committedEmail ? { email: committedEmail } : {}),
      });
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  };

  const shown = all ?? mine;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6">Give feedback</Typography>
      <TextField
        label="Your feedback"
        multiline
        fullWidth
        minRows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="contained" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? 'Sending…' : 'Submit'}
        </Button>
        {speechSupported && (
          <Button variant="outlined" onClick={toggleListen}>
            {listening ? 'Stop dictation' : 'Dictate by voice'}
          </Button>
        )}
      </Box>
      {!speechSupported && (
        <Typography variant="caption" color="text.secondary">
          Voice dictation is not available in this browser — type your feedback
          instead.
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="h6">{all ? 'All feedback' : 'My feedback'}</Typography>
      {all && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel id="feedback-status-label">Status</InputLabel>
            <Select
              labelId="feedback-status-label"
              label="Status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as string)}
            >
              <MenuItem value="">Any status</MenuItem>
              <MenuItem value="submitted">Submitted</MenuItem>
              <MenuItem value="in_progress">In progress</MenuItem>
              <MenuItem value="resolved">Resolved</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Filter by user"
            size="small"
            value={emailFilter}
            onChange={(e) => setEmailFilter(e.target.value)}
            placeholder="name or email"
          />
          <Button
            variant="outlined"
            size="small"
            onClick={doExport}
            disabled={exportBusy}
          >
            {exportBusy ? 'Exporting…' : 'Export filtered list'}
          </Button>
        </Box>
      )}
      {listError && <Alert severity="error">{listError}</Alert>}
      {shown.length === 0 && (
        <Typography color="text.secondary">No feedback yet.</Typography>
      )}
      {shown.map((f) => (
        <Paper key={f.id} sx={{ p: 2 }}>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle1">
              {f.username || f.email}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {f.username ? `${f.email} · ` : ''}{fmtDateTime(f.created_at)} · {f.status}
            </Typography>
            <Box sx={{ flexGrow: 1 }} />
            {all && (
              <FormControl size="small" sx={{ minWidth: 130 }}>
                <InputLabel id={`feedback-status-${f.id}`}>Status</InputLabel>
                <Select
                  labelId={`feedback-status-${f.id}`}
                  label="Status"
                  value={f.status}
                  onChange={(e) => void changeStatus(f.id, e.target.value as FeedbackStatus)}
                >
                  <MenuItem value="submitted">Submitted</MenuItem>
                  <MenuItem value="in_progress">In progress</MenuItem>
                  <MenuItem value="resolved">Resolved</MenuItem>
                </Select>
              </FormControl>
            )}
          </Box>
          <Typography sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>{f.text}</Typography>
        </Paper>
      ))}
    </Box>
  );
}
