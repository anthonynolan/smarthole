# smarthole

Personal hosted Anki reviewer. Import `.apkg` exports, review on an FSRS
spaced-repetition schedule. FastAPI + MongoDB Atlas (same cluster as grimoire,
separate database) + py-fsrs.

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
