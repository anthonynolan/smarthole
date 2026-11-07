"""smarthole: hosted Anki reviewer with FSRS scheduling on MongoDB Atlas."""

import hashlib
import mimetypes
import tempfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from mongoengine.connection import get_connection
from pydantic import BaseModel, EmailStr

load_dotenv()

from . import apkg_import, fsrs_service, mongo_connection
from .auth import (
    SESSION_COOKIE,
    SESSION_DAYS,
    create_session,
    destroy_session,
    get_current_user,
    get_google_client_id,
    hash_password,
    verify_google_token,
    verify_password,
)
from .models import Card, CardState, Deck, Media, Review, User

STATIC_DIR = Path(__file__).parent / "static"
CLIENT_DIST = Path(__file__).resolve().parents[2] / "smarthole-client" / "dist"


class AuthBody(BaseModel):
    email: EmailStr
    password: str


class ReviewBody(BaseModel):
    rating: int


class CardBody(BaseModel):
    deck_id: str
    front: str
    back: str


class GoogleBody(BaseModel):
    token: str


def utcnow() -> datetime:
    return datetime.now(UTC)


@asynccontextmanager
async def lifespan(app: FastAPI):
    mongo_connection.init()
    yield


def _anki_sched(icard) -> dict:
    return {
        "type": icard.anki_type,
        "queue": icard.anki_queue,
        "due": icard.anki_due,
        "ivl": icard.anki_ivl,
        "factor": icard.anki_factor,
        "reps": icard.anki_reps,
        "lapses": icard.anki_lapses,
        "last_rev": icard.last_rev,
        "crt": icard.anki_crt,
    }


def _refresh_imported_state(user: User, card: Card, icard) -> None:
    """Adopt Anki scheduling for a re-imported card.

    Skips cards studied in smarthole after the Anki data, which keep their
    local progress. (Ordering backfill happens in the import loop.)
    """
    state = CardState.objects(user=user, card=card).first()
    if state is None:
        return
    anki_last = fsrs_service.ensure_aware(icard.last_rev)
    introduced = fsrs_service.ensure_aware(state.introduced_at)
    if (
        state.reps > 0
        and introduced is not None
        and (anki_last is None or introduced >= anki_last)
    ):
        return
    adopted = fsrs_service.state_from_anki(_anki_sched(icard))
    state.update(
        state=adopted["state"],
        step=adopted["step"],
        stability=adopted["stability"],
        difficulty=adopted["difficulty"],
        due=adopted["due"],
        last_review=adopted["last_review"],
        reps=adopted["reps"],
        lapses=adopted["lapses"],
    )


def create_app() -> FastAPI:
    app = FastAPI(title="smarthole")

    @app.middleware("http")
    async def ensure_mongo_connection(request, call_next):
        try:
            get_connection()
        except Exception:
            try:
                mongo_connection.init()
                get_connection()
            except Exception as exc:
                return JSONResponse(
                    {
                        "detail": (
                            "Database not connected "
                            f"({exc}). Check MONGO_PWD/MONGO_DB_NAME and "
                            "that TESTING is unset."
                        )
                    },
                    status_code=500,
                )
        return await call_next(request)

    @app.post("/api/register", status_code=201)
    def register(body: AuthBody):
        email = body.email.lower()
        if User.objects(email=email).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
        user = User(email=email, pw_hash=hash_password(body.password)).save()
        session = create_session(user)
        return _session_response(session.session_id, {"email": email}, 201)

    @app.post("/api/login")
    def login(body: AuthBody):
        user = User.objects(email=body.email.lower()).first()
        if user is None or not verify_password(body.password, user.pw_hash):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        session = create_session(user)
        return _session_response(session.session_id, {"email": user.email})

    @app.post("/api/logout")
    def logout(
        user: User = Depends(get_current_user),
        session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    ):
        if session_id:
            destroy_session(session_id)
        resp = Response(content='{"ok": true}', media_type="application/json")
        resp.delete_cookie(SESSION_COOKIE)
        return resp

    @app.get("/api/me")
    def me(user: User = Depends(get_current_user)):
        return {"email": user.email}

    @app.get("/api/config")
    def config():
        try:
            client_id = get_google_client_id()
        except RuntimeError:
            client_id = None
        return {"googleClientId": client_id}

    @app.post("/api/google")
    def google_login(body: GoogleBody):
        info = verify_google_token(body.token)
        user = User.objects(email=info["email"]).first()
        if user is None:
            user = User(
                email=info["email"],
                name=info["name"],
                picture=info["picture"],
                google_sub=info["sub"],
            ).save()
        else:
            updates = {}
            if info["name"] and user.name != info["name"]:
                updates["name"] = info["name"]
            if info["picture"] and user.picture != info["picture"]:
                updates["picture"] = info["picture"]
            if info["sub"] and user.google_sub != info["sub"]:
                updates["google_sub"] = info["sub"]
            if updates:
                user.update(**{f"set__{k}": v for k, v in updates.items()})
                user.reload()
        session = create_session(user)
        return _session_response(session.session_id, {"email": user.email})

    @app.get("/api/decks")
    def list_decks(user: User = Depends(get_current_user)):
        decks = Deck.objects(owner=user)
        out = []
        for deck in decks:
            cards = list(Card.objects(deck=deck))
            active_ids = [c.id for c in cards if not c.suspended]
            if active_ids:
                due = CardState.objects(
                    user=user, card__in=active_ids, reps__gt=0, due__lte=utcnow()
                ).count()
                new = CardState.objects(user=user, card__in=active_ids, reps=0).count()
            else:
                due = new = 0
            out.append(
                {
                    "id": str(deck.id),
                    "name": deck.name,
                    "total": len(cards),
                    "due": due,
                    "new": new,
                }
            )
        return {"decks": out}

    @app.get("/api/decks/{deck_id}/cards")
    def browse_deck(
        deck_id: str,
        sort: Literal["due", "last_review"] = Query(default="due"),
        direction: Literal["asc", "desc"] = Query(default="asc"),
        skip: int = Query(default=0, ge=0),
        limit: int = Query(default=20, ge=1, le=100),
        user: User = Depends(get_current_user),
    ):
        deck = Deck.objects(owner=user, id=deck_id).first()
        if deck is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Deck not found")
        card_ids = [c.id for c in Card.objects(deck=deck)]
        total = (
            CardState.objects(user=user, card__in=card_ids).count() if card_ids else 0
        )
        states = _paged_states(user, card_ids, sort, direction, skip, limit)
        cards = {c.id: c for c in Card.objects(id__in=[s.card.id for s in states])}
        rows = []
        for s in states:
            card = cards.get(s.card.id)
            if card is None:
                continue
            rows.append(
                {
                    "card_id": str(card.id),
                    "front_text": plain_text(card.front_html),
                    "due": s.due.isoformat() if s.due else None,
                    "last_review": s.last_review.isoformat() if s.last_review else None,
                    "state": s.state,
                    "reps": s.reps,
                    "suspended": card.suspended,
                }
            )
        return {"cards": rows, "total": total}

    @app.post("/api/cards", status_code=201)
    def create_card(body: CardBody, user: User = Depends(get_current_user)):
        if not body.front.strip() or not body.back.strip():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "front and back must be non-empty"
            )
        try:
            deck = Deck.objects(owner=user, id=body.deck_id).first()
        except Exception:
            deck = None
        if deck is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Deck not found")
        existing = Card.objects(deck=deck).only("new_position")
        new_position = max((c.new_position or 0 for c in existing), default=0) + 1
        card = Card(
            deck=deck,
            front_html=apkg_import.sanitize(body.front),
            back_html=apkg_import.sanitize(body.back),
            new_position=new_position,
        ).save()
        CardState(
            user=user,
            card=card,
            new_position=new_position,
            **fsrs_service.fresh_state(),
        ).save()
        return {"card_id": str(card.id), "deck_id": str(deck.id)}

    @app.post("/api/import", status_code=201)
    def import_apkg(
        file: UploadFile = File(...), user: User = Depends(get_current_user)
    ):
        name = (file.filename or "").lower()
        if not name.endswith((".apkg", ".colpkg")):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Upload a .apkg or .colpkg file"
            )
        with tempfile.NamedTemporaryFile(suffix=".apkg", delete=False) as tmp:
            tmp.write(file.file.read())
            tmp_path = tmp.name
        try:
            result = apkg_import.parse_apkg(tmp_path)
        except Exception as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Bad package: {exc}"
            ) from exc
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        filename_to_url = _store_media(result.media)
        imported = 0
        for ideck in result.decks:
            deck = Deck.objects(owner=user, name=ideck.name).first()
            if deck is None:
                deck = Deck(
                    owner=user, name=ideck.name, source_apkg=file.filename
                ).save()
            existing = {(c.anki_nid, c.anki_ord): c for c in Card.objects(deck=deck)}
            for icard in ideck.cards:
                key = (icard.anki_nid, icard.anki_ord)
                old = existing.get(key)
                if old is not None:
                    if not old.new_position and icard.anki_due:
                        old.update(set__new_position=icard.anki_due)
                        skipped = CardState.objects(user=user, card=old).first()
                        if skipped is not None and not skipped.new_position:
                            skipped.update(set__new_position=icard.anki_due)
                    if icard.suspended != old.suspended:
                        old.update(set__suspended=icard.suspended)
                    if result.scheduling:
                        _refresh_imported_state(user, old, icard)
                    continue
                existing[key] = None
                card = Card(
                    deck=deck,
                    front_html=apkg_import.rewrite_media_refs(
                        icard.front_html, filename_to_url
                    ),
                    back_html=apkg_import.rewrite_media_refs(
                        icard.back_html, filename_to_url
                    ),
                    anki_nid=icard.anki_nid,
                    anki_ord=icard.anki_ord,
                    anki_guid=icard.anki_guid,
                    suspended=icard.suspended,
                    new_position=icard.anki_due,
                ).save()
                CardState(
                    user=user,
                    card=card,
                    new_position=icard.anki_due,
                    **fsrs_service.state_from_anki(_anki_sched(icard)),
                ).save()
                imported += 1
        due_now = _review_due_count(user)
        return {
            "imported": imported,
            "decks": len(result.decks),
            "scheduling": result.scheduling,
            "due": due_now,
        }

    @app.get("/api/next")
    def next_cards(
        deck_id: str | None = None,
        limit: int = 1,
        user: User = Depends(get_current_user),
    ):
        limit = max(limit, 1)
        deck = None
        if deck_id:
            deck = Deck.objects(owner=user, id=deck_id).first()
            if deck is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Deck not found")
        cards = _active_cards(user, deck)
        out = []
        review_query: dict = {
            "user": user,
            "card__in": list(cards),
            "reps__gt": 0,
            "due__lte": utcnow(),
        }
        for s in CardState.objects(**review_query).order_by("due").limit(limit):
            out.append(_present_state(s))
        if len(out) < limit:
            for s in _new_queue(user, cards, limit - len(out)):
                out.append(_present_state(s))
        return {"cards": out}

    @app.post("/api/review/{card_id}")
    def review_card(
        card_id: str, body: ReviewBody, user: User = Depends(get_current_user)
    ):
        if body.rating not in (1, 2, 3, 4):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "rating must be 1-4")
        card = Card.objects(id=card_id).first()
        if card is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        state = CardState.objects(user=user, card=card).first()
        if state is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No state for this card")
        current = {
            "fsrs_card_id": state.fsrs_card_id,
            "state": state.state,
            "step": state.step,
            "stability": state.stability,
            "difficulty": state.difficulty,
            "due": state.due,
            "last_review": state.last_review,
            "reps": state.reps,
            "lapses": state.lapses,
        }
        now = utcnow()
        first_grading = state.reps == 0
        updated = fsrs_service.apply_rating(current, body.rating, now)
        changes = {
            "state": updated["state"],
            "step": updated["step"],
            "stability": updated["stability"],
            "difficulty": updated["difficulty"],
            "due": updated["due"],
            "last_review": updated["last_review"],
            "reps": updated["reps"],
            "lapses": updated["lapses"],
        }
        if first_grading and state.introduced_at is None:
            changes["introduced_at"] = now
        state.update(**changes)
        Review(
            user=user,
            card=card,
            rating=body.rating,
            reviewed_at=utcnow(),
            next_due=updated["due"],
            stability=updated["stability"],
            difficulty=updated["difficulty"],
        ).save()
        state.reload()
        return _present_state(state)

    @app.get("/api/stats")
    def stats(user: User = Depends(get_current_user)):
        deck_ids = [d.id for d in Deck.objects(owner=user)]
        cards = list(Card.objects(deck__in=deck_ids)) if deck_ids else []
        active = {c.id: c for c in cards if not c.suspended}
        states = (
            list(CardState.objects(user=user, card__in=list(active))) if active else []
        )
        now = utcnow()
        today = _day_start()
        aware = fsrs_service.ensure_aware

        def is_due(s: CardState) -> bool:
            return s.reps > 0 and s.due is not None and aware(s.due) <= now

        new = sum(1 for s in states if s.reps == 0)
        learning = sum(1 for s in states if s.reps > 0 and s.state in (1, 3))
        review = sum(1 for s in states if s.reps > 0 and s.state == 2)
        due = sum(1 for s in states if is_due(s))
        today_reviews = list(Review.objects(user=user, reviewed_at__gte=today))
        studied = len({r.card.id for r in today_reviews})
        new_today = sum(
            1 for s in states if s.introduced_at and aware(s.introduced_at) >= today
        )
        grades = [r.rating for r in today_reviews]
        accuracy = (
            round(100 * sum(1 for g in grades if g > 1) / len(grades), 1)
            if grades
            else None
        )
        forecast = []
        for i in range(30):
            day = today + timedelta(days=i)
            nxt = day + timedelta(days=1)
            forecast.append(
                {
                    "date": day.date().isoformat(),
                    "due": sum(
                        1
                        for s in states
                        if s.reps > 0
                        and s.due is not None
                        and day <= aware(s.due) < nxt
                    ),
                }
            )
        return {
            "totals": {
                "cards": len(cards),
                "new": new,
                "learning": learning,
                "review": review,
                "suspended": len(cards) - len(active),
                "due": due,
            },
            "today": {
                "studied": studied,
                "new": new_today,
                "reviews": len(today_reviews),
                "accuracy": accuracy,
            },
            "forecast": forecast,
        }

    @app.get("/media/{sha}")
    def serve_media(sha: str):
        item = Media.objects(sha256=sha).first()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
        return Response(content=bytes(item.data), media_type=item.content_type)

    @app.get("/", response_class=HTMLResponse)
    def index():
        client_index = CLIENT_DIST / "index.html"
        if client_index.is_file():
            return client_index.read_text()
        return (STATIC_DIR / "index.html").read_text()

    if (CLIENT_DIST / "assets").is_dir():
        app.mount(
            "/assets", StaticFiles(directory=CLIENT_DIST / "assets"), name="assets"
        )
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def _session_response(
    session_id: str, payload: dict, status_code: int = 200
) -> Response:
    import json

    resp = Response(
        content=json.dumps(payload),
        media_type="application/json",
        status_code=status_code,
    )
    resp.set_cookie(
        SESSION_COOKIE,
        session_id,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
    )
    return resp


def _store_media(media: dict[str, bytes]) -> dict[str, str]:
    mapping = {}
    for filename, blob in media.items():
        sha = hashlib.sha256(blob).hexdigest()
        if Media.objects(sha256=sha).first() is None:
            ctype, _ = mimetypes.guess_type(filename)
            Media(
                sha256=sha,
                filename=filename,
                content_type=ctype or "application/octet-stream",
                data=blob,
            ).save()
        mapping[filename] = f"/media/{sha}"
    return mapping


def _day_start() -> datetime:
    return utcnow().replace(hour=0, minute=0, second=0, microsecond=0)


def _active_cards(user: User, deck: Deck | None) -> dict:
    """Active (non-suspended) cards by id, optionally scoped to one deck."""
    if deck is not None:
        found = Card.objects(deck=deck, suspended=False)
    else:
        deck_ids = [d.id for d in Deck.objects(owner=user)]
        found = Card.objects(deck__in=deck_ids, suspended=False) if deck_ids else []
    return {c.id: c for c in found}


def _new_budget(user: User) -> int:
    introduced_today = CardState.objects(
        user=user, introduced_at__gte=_day_start()
    ).count()
    return max(0, fsrs_service.NEW_CARDS_PER_DAY - introduced_today)


def _new_queue(user: User, cards: dict, count: int) -> list[CardState]:
    """Unseen cards in Anki new-order, capped by the remaining daily budget."""
    budget = _new_budget(user)
    if count <= 0 or budget <= 0 or not cards:
        return []
    return list(
        CardState.objects(user=user, card__in=list(cards), reps=0, due__lte=utcnow())
        .order_by("new_position", "id")
        .limit(min(count, budget))
    )


def _paged_states(
    user: User, card_ids: list, sort: str, direction: str, skip: int, limit: int
) -> list[CardState]:
    """One page of states, sorted server-side with nulls always last."""
    field = "due" if sort == "due" else "last_review"
    prefix = "-" if direction == "desc" else ""
    present_query = {"user": user, "card__in": card_ids, f"{field}__ne": None}
    total_present = CardState.objects(**present_query).count()
    page = list(
        CardState.objects(**present_query)
        .order_by(f"{prefix}{field}")
        .skip(skip)
        .limit(limit)
    )
    if len(page) < limit:
        null_skip = max(0, skip - total_present)
        null_query = {"user": user, "card__in": card_ids, field: None}
        page += list(
            CardState.objects(**null_query)
            .order_by("id")
            .skip(null_skip)
            .limit(limit - len(page))
        )
    return page


def _review_due_count(user: User) -> int:
    cards = _active_cards(user, None)
    if not cards:
        return 0
    return CardState.objects(
        user=user, card__in=list(cards), reps__gt=0, due__lte=utcnow()
    ).count()


def plain_text(html: str, limit: int = 120) -> str:
    """Card HTML as truncated plain text for table display."""
    import html as html_module
    from html.parser import HTMLParser

    class _Text(HTMLParser):
        blocks = {"p", "div", "br", "li", "tr", "hr", "h1", "h2", "h3"}

        def __init__(self):
            super().__init__()
            self.parts: list[str] = []

        def handle_data(self, data: str):
            self.parts.append(data)

        def handle_endtag(self, tag: str):
            if tag in self.blocks:
                self.parts.append(" ")

    parser = _Text()
    parser.feed(html or "")
    text = html_module.unescape(" ".join("".join(parser.parts).split()))
    if len(text) > limit:
        return text[:limit] + "…"
    return text


def _present_state(state: CardState) -> dict:
    card = state.card
    return {
        "card_id": str(card.id),
        "deck_id": str(card.deck.id),
        "front_html": card.front_html,
        "back_html": card.back_html,
        "due": state.due.isoformat(),
        "state": state.state,
        "reps": state.reps,
    }


app = create_app()
