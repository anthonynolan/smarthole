# smarthole

Personal hosted Anki reviewer. Import `.apkg` exports, review on an FSRS
spaced-repetition schedule. FastAPI + MongoDB Atlas (same cluster as grimoire,
separate database) + py-fsrs.

## Features

- Sign in with Google, or register / log in with email + password.
- Import `.apkg` deck exports and full `.colpkg` collection backups
  (modern 23.10+ and legacy formats), with live streamed progress
  (cards read, then cards saved); Anki scheduling is kept when the file
  includes it (re-import to refresh).
- Review due cards with Again / Hard / Good / Easy; each grade button
  previews the next-due interval, and the review screen shows how many
  cards are due today.
- FSRS scheduling (`desired_retention=0.9`, learning steps 1m/10m, 10m
  relearning, fuzzing on) with a single wave of due cards per day — a card
  graded today never comes due again until tomorrow.
- Anki-style daily limit of 20 new cards per day, in Anki new-order
  (tune with `NEW_CARDS_PER_DAY`).
- Add cards, and edit cards with formatting preserved: line breaks survive
  the round trip, and a small markdown subset (`**bold**`, `*italic*`,
  `` `code` ``, `[links](https://…)`) renders on the card.
- The edit screen shows all metadata for the card (IDs, deck, creation
  date, due / last review, FSRS state, step, stability, difficulty, reps,
  lapses, Anki note/ord/GUID, suspension and deletion flags) for data and
  system troubleshooting.
- Deletion is logical by default: deleted cards are hidden everywhere but
  keep their scheduling state and review history. Deleting happens from
  inside the edit screen.
- Browse the deck with search; a green line separates cards due today
  from the rest. A "Show deleted" toggle lists only deleted cards, where
  each row offers Restore or permanent Delete forever (only permanent
  deletion removes the schedule and review history).
- AI review of a card: split it into single-fact cards, or ask a question
  about it (the question box only appears for that option). The chosen
  option and question stay visible while the call runs; live statuses
  (`sent`, `awaiting response`, `streaming`, `finished`) and the model
  name are shown.
- Card embeddings (OpenAI `text-embedding-3-small`, same method as
  grimoire) with an Atlas vector index for similarity search. While
  reviewing, the closest related card appears as a title link — click it
  before grading and it goes next in the review queue. Setup: add
  `OPENAI_API_KEY` to `.env` and `.env.prod`, then run
  `uv run scripts/create_card_vector_index.py --db smarthole_prod` once
  and `uv run scripts/backfill_card_embeddings.py --db smarthole_prod`
  to embed existing cards (new/edited cards embed automatically).
  Tune with `EMBEDDING_MODEL` and `RELATED_MIN_SCORE` (default 0.7).
- Stats: due/new/learning/reviewed-today counts, today's accuracy, and a
  30-day due forecast. Dates render unambiguously as `12-Nov'26`.
- Deploy via GitHub Actions on every push to `master` (see
  [docs/deploy.md](docs/deploy.md)); the local
  `scripts/deploy_lightsail.sh` remains as a fallback.

## Setup

```bash
cp .env.example .env   # fill in MONGO_PWD (Atlas password, never commit it)
./dev_start_uvicorn.sh
```

Open `http://localhost:8123` in a browser. (Port 8123 avoids your `tracker`
app on 8001.)

The UI is React + MUI in `smarthole-client/` (same stack as grimoire's
client). First build it once:

```bash
cd smarthole-client && npm install && npm run build
```

The backend serves `smarthole-client/dist` at `/` (falls back to the legacy
page if unbuilt). For UI development with hot reload:

```bash
cd smarthole-client && npm run dev   # proxied /api -> localhost:8123
```

- Default database is `smarthole_dev`. Production uses `smarthole_prod`
  (`ENV=prod` or `MONGO_DB_NAME=smarthole_prod`).
- Same convention as grimoire-service: `MONGO_PWD` password,
  `MONGO_DB_NAME` override.

## Use

1. Sign in with Google, or register / log in with email + password.
2. Open the menu and choose Import. Pick a `.apkg` deck export — or a full
   `.colpkg` collection backup from Anki's `AppData/Roaming/Anki2/<profile>/backups`
   folder (from WSL: `/mnt/c/Users/<you>/AppData/Roaming/Anki2/<profile>/backups`).
   Modern (23.10+) and legacy formats work; card content is rendered with
   Anki's own importer, and scheduling imports with it (re-import to refresh).
   The Import view streams live progress — cards read, then cards saved —
   from `POST /api/import?stream=true` (plain `POST /api/import` still
   returns one JSON result).
3. Review due cards with Again / Hard / Good / Easy; the review screen shows
   how many are due today across the selected scope. Browse the deck, add
   cards, and check Stats from the same menu. Dates render unambiguously as
   `12-Nov'26`.

## Scheduling

Grades drive the FSRS scheduler (`fsrs` package, default parameters,
`desired_retention=0.9`, learning steps 1m/10m, 10m relearning, fuzzing on).
Intraday steps are clamped to the start of the next day, so there is only
ever one wave of due cards per day.

Imports keep your Anki schedule when the file has one: review intervals stand
in for stability, ease maps to difficulty, and due dates anchor on your last
logged review plus the interval. Learning cards keep their due time; suspended
cards stay suspended. To get this, export from Anki with **Include scheduling
information** checked — without it every card arrives as new (the import
message says which happened).

New cards follow Anki's daily limit: 20 fresh cards are introduced per day, in
Anki new-order, regardless of how many pile up. Reviews due stay at 0 until
something actually comes due — this mirrors Anki's own counts. Tune with
`NEW_CARDS_PER_DAY` in the environment.

## Tests

```bash
uv run --group test pytest
```

Tests run against `mongomock` (`TESTING=1` disables the Atlas connection).
