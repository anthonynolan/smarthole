"""APKG import.

Modern Anki (23.10+) exports a protobuf package (``meta`` + ``*.anki21b`` +
media map) which is imported with the official ``anki`` package's backend, so
templates, cloze, and media resolve exactly as Anki renders them. Legacy
exports (``*.anki2`` SQLite + JSON ``media`` map) use a stdlib-only parser.

Scheduling columns (ivl/factor/due) are deliberately ignored: every imported
card starts fresh under FSRS.
"""

import contextlib
import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import bleach

SUSPENDED_QUEUE = -1
BURIED_QUEUES = (-2, -3)
MAX_CARDS = 200_000
# Cards between progress events while parsing or saving.
PROGRESS_EVERY = 25

ALLOWED_TAGS = [
    "p",
    "br",
    "b",
    "i",
    "u",
    "em",
    "strong",
    "div",
    "span",
    "img",
    "ul",
    "ol",
    "li",
    "table",
    "tr",
    "td",
    "th",
    "hr",
    "pre",
    "code",
    "a",
    "audio",
    "source",
    "sub",
    "sup",
]
ALLOWED_ATTRS = {
    "img": ["src", "alt"],
    "a": ["href"],
    "audio": ["src", "controls"],
    "source": ["src", "type"],
}


@dataclass
class ImportedCard:
    front_html: str
    back_html: str
    anki_nid: int
    anki_ord: int
    anki_guid: str
    suspended: bool = False
    # Anki scheduling (absent/zero when exported without scheduling info).
    anki_type: int = 0  # 0 new, 1 learning, 2 review
    anki_queue: int = 0
    anki_due: int | None = None  # None = unknown; 0 means due now
    anki_ivl: int = 0
    anki_factor: int = 0
    anki_reps: int = 0
    anki_lapses: int = 0
    last_rev: datetime | None = None
    anki_crt: int = 0  # source collection creation time (day-anchored dues)


@dataclass
class ImportedDeck:
    name: str
    cards: list[ImportedCard] = field(default_factory=list)


@dataclass
class ImportResult:
    decks: list[ImportedDeck]
    media: dict[str, bytes]  # filename -> raw bytes
    scheduling: bool = False  # True when the file holds review history


def sanitize(html: str) -> str:
    # Drop template chrome entirely (bleach would keep the CSS text).
    html = re.sub(r"(?is)<(style|script)[^>]*>.*?</\1>", "", html)
    return bleach.clean(html, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS, strip=True)


def html_to_text(html: str) -> str:
    """Card HTML back to editable plain text, preserving line breaks.

    Block ends (paragraphs, divs, list items, table rows, headings, <br>,
    <hr>) become newlines so a card edited in a textarea round-trips
    without losing its line breaks.
    """
    import html as html_module
    from html.parser import HTMLParser

    BLOCKS = {"p", "div", "li", "tr", "hr", "h1", "h2", "h3", "h4", "ul", "ol"}

    class _Text(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts: list[str] = []

        def handle_starttag(self, tag: str, attrs):
            if tag == "br":
                self.parts.append("\n")

        def handle_data(self, data: str):
            self.parts.append(data)

        def handle_endtag(self, tag: str):
            if tag in BLOCKS:
                self.parts.append("\n")

    parser = _Text()
    parser.feed(html or "")
    text = html_module.unescape("".join(parser.parts))
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _markdown_text_segment(segment: str) -> str:
    """Escape one tag-free text segment, then apply inline markdown."""
    import html as html_module

    escaped = html_module.escape(segment, quote=False)
    # Inline code first so its contents are not treated as markdown.
    codes: list[str] = []

    def _code(m: re.Match) -> str:
        codes.append(f"<code>{m.group(1)}</code>")
        return f"\ue000{len(codes) - 1}\ue001"

    escaped = re.sub(r"`([^`\n]+)`", _code, escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(^|[\s>(])\*([^*\n]+)\*", r"\1<em>\2</em>", escaped)
    escaped = re.sub(
        r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', escaped
    )
    for i, code in enumerate(codes):
        escaped = escaped.replace(f"\ue000{i}\ue001", code)
    return escaped.replace("\n", "<br>")


def render_plain_text(text: str) -> str:
    """User-typed card text (add/edit forms) to safe display HTML.

    Real HTML tags pass through (then the usual sanitize pass); text
    between tags is escaped, keeps newlines as ``<br>``, and supports a
    small markdown subset: **bold**, *italic*, `code`, [links](url).
    Imported Anki HTML keeps going through :func:`sanitize` directly.
    """
    parts = re.split(r"(<[^>]*>)", text or "")
    rendered = [
        part if (part.startswith("<") and part.endswith(">")) else _markdown_text_segment(part)
        for part in parts
    ]
    return sanitize("".join(rendered))


def rewrite_media_refs(html: str, filename_to_url: dict[str, str]) -> str:
    for filename, url in filename_to_url.items():
        html = html.replace(f'src="{filename}"', f'src="{url}"')
        html = html.replace(f"src='{filename}'", f"src='{url}'")
    return html


def parse_apkg(path: str | Path, on_progress=None) -> ImportResult:
    """Parse a package, calling ``on_progress(stage, done, total)`` as cards
    are read. ``stage`` is ``"parse"`` here; saving progress is reported by
    the caller (see ``/api/import?stream=true``)."""
    events = parse_apkg_events(path)
    while True:
        try:
            stage, done, total = next(events)
        except StopIteration as stop:
            return stop.value
        if on_progress is not None:
            on_progress(stage, done, total)


def parse_apkg_events(path: str | Path):
    """Yield ``(stage, done, total)`` tuples while parsing; the generator's
    return value is the finished :class:`ImportResult`."""
    path = Path(path)
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
    if "meta" in names or any(n.endswith(".anki21b") for n in names):
        result = yield from _parse_with_anki(path)
    else:
        result = yield from _parse_legacy(path, names)
    result.scheduling = any(
        c.anki_type != 0 or c.anki_reps > 0 or c.anki_ivl > 0
        for deck in result.decks
        for c in deck.cards
    )
    return result


def _parse_legacy(path: Path, names: list[str]):
    """Yield parse-progress tuples; return the finished ImportResult."""
    with zipfile.ZipFile(path) as zf:
        anki2 = [n for n in names if n.endswith(".anki2")]
        if not anki2:
            raise ValueError("Not an .apkg: no *.anki2 database inside")
        db_name = anki2[0]
        media_map: dict[str, str] = {}
        if "media" in names:
            media_map = json.loads(zf.read("media").decode("utf-8"))
        media: dict[str, bytes] = {}
        for index, filename in media_map.items():
            if index in names:
                media[filename] = zf.read(index)
        if "media" not in names:
            # Old collection backups (.colpkg) store media under real
            # filenames instead of a numeric map.
            for entry in names:
                if entry != db_name and "/" not in entry:
                    media.setdefault(entry, zf.read(entry))
        blob = zf.read(db_name)
        fd, tmp_name = tempfile.mkstemp(prefix="smarthole-legacy-", suffix=".anki2")
        tmp = Path(tmp_name)
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
    try:
        return (yield from _parse_db(tmp, media))
    finally:
        tmp.unlink(missing_ok=True)


def _source_crt(path: Path) -> int:
    """Collection creation time from a package's legacy stub (0 if absent)."""
    try:
        with zipfile.ZipFile(path) as zf:
            if "collection.anki2" not in zf.namelist():
                return 0
            blob = zf.read("collection.anki2")
        fd, tmp_name = tempfile.mkstemp(prefix="smarthole-crt-", suffix=".anki2")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(blob)
            conn = sqlite3.connect(tmp)
            try:
                row = conn.execute("SELECT crt FROM col LIMIT 1").fetchone()
                return int(row[0]) if row and row[0] else 0
            finally:
                conn.close()
        finally:
            tmp.unlink(missing_ok=True)
    except (zipfile.BadZipFile, sqlite3.Error, ValueError, OSError):
        return 0


def _parse_with_anki(path: Path):
    """Import a modern (protobuf) package with Anki's own backend.

    Yield ``("parse", done, total)`` as cards are read; return the finished
    ImportResult."""
    from anki.collection import Collection, ImportAnkiPackageRequest

    workdir = Path(tempfile.mkdtemp(prefix="smarthole-apkg-"))
    col = Collection(str(workdir / "import.anki2"))
    try:
        request = ImportAnkiPackageRequest()
        request.package_path = str(path)
        request.options.with_scheduling = True
        request.options.with_deck_configs = True
        with contextlib.redirect_stderr(io.StringIO()):
            col.import_anki_package(request)
        crt = _source_crt(path)
        media: dict[str, bytes] = {}
        media_dir = Path(col.media.dir())
        for fname in sorted(os.listdir(media_dir)):
            fpath = media_dir / fname
            if fpath.is_file():
                media[fname] = fpath.read_bytes()
        db = sqlite3.connect(workdir / "import.anki2")
        try:
            sched, last_rev = _load_scheduling(db)
        finally:
            db.close()
        decks: dict[str, ImportedDeck] = {}
        cids = col.find_cards("")
        total = len(cids)
        for done, cid in enumerate(cids, start=1):
            card = col.get_card(cid)
            note = card.note()
            deck_name = col.decks.name(card.did)
            deck = decks.setdefault(deck_name, ImportedDeck(name=deck_name))
            ctype, _q, due, ivl, factor, reps, lapses = sched.get(
                cid, (0, card.queue, None, 0, 0, 0, 0)
            )
            deck.cards.append(
                ImportedCard(
                    front_html=sanitize(card.question()),
                    back_html=sanitize(card.answer()),
                    anki_nid=int(note.id),
                    anki_ord=card.ord,
                    anki_guid=note.guid,
                    suspended=card.queue == SUSPENDED_QUEUE,
                    anki_type=ctype,
                    anki_queue=card.queue,
                    anki_due=due,
                    anki_ivl=ivl,
                    anki_factor=factor,
                    anki_reps=reps,
                    anki_lapses=lapses,
                    last_rev=last_rev.get(cid),
                    anki_crt=crt,
                )
            )
            if sum(len(d.cards) for d in decks.values()) > MAX_CARDS:
                raise ValueError(f"Import exceeds {MAX_CARDS} cards")
            if done == total or done % PROGRESS_EVERY == 0:
                yield ("parse", done, total)
    finally:
        col.close()
        shutil.rmtree(workdir, ignore_errors=True)
    return ImportResult(decks=list(decks.values()), media=media)


def _load_scheduling(
    conn: sqlite3.Connection,
) -> tuple[dict[int, tuple], dict[int, datetime]]:
    """Return ({card_id: (type, queue, due, ivl, factor, reps, lapses)},
    {card_id: last review time}). Empty when the export holds no scheduling."""
    sched: dict[int, tuple] = {}
    try:
        rows = conn.execute(
            "SELECT id, type, queue, due, ivl, factor, reps, lapses FROM cards"
        )
    except sqlite3.Error:
        return {}, {}
    for cid, ctype, queue, due, ivl, factor, reps, lapses in rows:
        sched[cid] = (
            ctype or 0,
            queue if queue is not None else 0,
            due,  # None = unknown; 0 is a real Anki day meaning due now
            ivl or 0,
            factor or 0,
            reps or 0,
            lapses or 0,
        )
    last: dict[int, datetime] = {}
    try:
        for cid, max_id in conn.execute("SELECT cid, MAX(id) FROM revlog GROUP BY cid"):
            last[cid] = datetime.fromtimestamp(max_id / 1000, tz=timezone.utc)
    except sqlite3.Error:
        pass
    return sched, last


def _collection_crt(conn: sqlite3.Connection, tables: set[str]) -> int:
    if "col" not in tables:
        return 0
    try:
        row = conn.execute("SELECT crt FROM col LIMIT 1").fetchone()
        return int(row[0]) if row and row[0] else 0
    except (sqlite3.Error, ValueError, TypeError):
        return 0


def _parse_db(db_path: Path, media: dict[str, bytes]):
    """Yield ``("parse", done, total)`` as cards are read; return the
    finished ImportResult."""
    conn = sqlite3.connect(db_path)
    try:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        models, deck_names = _load_models_and_decks(conn, tables)
        notes = _load_notes(conn)
        cards = _load_cards(conn)
        sched, last_rev = _load_scheduling(conn)
        crt = _collection_crt(conn, tables)
    finally:
        conn.close()

    decks: dict[str, ImportedDeck] = {}
    total = len(cards)
    for done, (_cid, nid, did, ord_, queue) in enumerate(cards, start=1):
        note = notes.get(nid)
        if note is None:
            if done == total or done % PROGRESS_EVERY == 0:
                yield ("parse", done, total)
            continue
        guid, mid, fields = note
        deck_name = deck_names.get(did, f"Imported deck {did}")
        front, back = render_card(models.get(mid), ord_, fields)
        deck = decks.setdefault(deck_name, ImportedDeck(name=deck_name))
        ctype, _q, due, ivl, factor, reps, lapses = sched.get(
            _cid, (0, queue, None, 0, 0, 0, 0)
        )
        deck.cards.append(
            ImportedCard(
                front_html=sanitize(front),
                back_html=sanitize(back),
                anki_nid=nid,
                anki_ord=ord_,
                anki_guid=guid,
                suspended=queue == SUSPENDED_QUEUE,
                anki_type=ctype,
                anki_queue=queue,
                anki_due=due,
                anki_ivl=ivl,
                anki_factor=factor,
                anki_reps=reps,
                anki_lapses=lapses,
                last_rev=last_rev.get(_cid),
                anki_crt=crt,
            )
        )
        if sum(len(d.cards) for d in decks.values()) > MAX_CARDS:
            raise ValueError(f"Import exceeds {MAX_CARDS} cards")
        if done == total or done % PROGRESS_EVERY == 0:
            yield ("parse", done, total)
    return ImportResult(decks=list(decks.values()), media=media)


def _load_models_and_decks(
    conn: sqlite3.Connection, tables: set[str]
) -> tuple[dict, dict]:
    """Return (models by mid, deck names by did)."""
    models: dict = {}
    deck_names: dict = {}
    if "col" in tables:
        row = conn.execute("SELECT models, decks FROM col LIMIT 1").fetchone()
        if row:
            try:
                raw_models = json.loads(row[0]) if isinstance(row[0], str) else row[0]
                for mid, m in (raw_models or {}).items():
                    models[int(mid)] = m
            except (ValueError, TypeError):
                pass
            try:
                raw_decks = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                for did, d in (raw_decks or {}).items():
                    deck_names[int(did)] = d.get("name", f"Deck {did}")
            except (ValueError, TypeError):
                pass
    if "decks" in tables and not deck_names:
        try:
            for did, name in conn.execute("SELECT id, name FROM decks"):
                deck_names[int(did)] = name
        except sqlite3.Error:
            pass
    return models, deck_names


def _load_notes(conn: sqlite3.Connection) -> dict[int, tuple[str, int, list[str]]]:
    notes = {}
    for nid, guid, mid, flds in conn.execute("SELECT id, guid, mid, flds FROM notes"):
        fields = flds.split("\x1f") if flds else []
        notes[nid] = (guid, mid, fields)
    return notes


def _load_cards(conn: sqlite3.Connection) -> list[tuple]:
    return list(conn.execute("SELECT id, nid, did, ord, queue FROM cards"))


def render_card(model: dict | None, ord_: int, fields: list[str]) -> tuple[str, str]:
    """Render front/back via the note template, or field fallback."""
    if model:
        try:
            field_names = [f["name"] for f in model.get("flds", [])]
            mapping = dict(zip(field_names, fields, strict=False))
            tmpls = model.get("tmpls", [])
            tmpl = next(
                (t for t in tmpls if t.get("ord") == ord_),
                tmpls[0] if tmpls else None,
            )
            if tmpl:
                front = _substitute(tmpl.get("qfmt", ""), mapping)
                back = _substitute(tmpl.get("afmt", ""), mapping, front_side=front)
                return front, back
        except (IndexError, AttributeError, TypeError):
            pass
    front = fields[0] if fields else ""
    back = "<hr>".join(fields[1:]) if len(fields) > 1 else ""
    return front, back


def _substitute(template: str, mapping: dict[str, str], front_side: str = "") -> str:
    out = template.replace("{{FrontSide}}", front_side)
    for name, value in mapping.items():
        out = out.replace("{{" + name + "}}", value or "")
    out = re.sub(r"{{[^}]*}}", "", out)
    return out
