"""smarthole: hosted Anki reviewer with FSRS scheduling on MongoDB Atlas."""

import hashlib
import json
import logging
import mimetypes
import os
import re
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
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from mongoengine import Q
from mongoengine.connection import get_connection
from pydantic import BaseModel, EmailStr

load_dotenv()

logger = logging.getLogger(__name__)

from . import ai_review, apkg_import, embeddings, fsrs_service, mongo_connection
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


class CardUpdateBody(BaseModel):
    front: str
    back: str


class AiReviewBody(BaseModel):
    mode: Literal["split", "custom"] = "split"
    question: str | None = None


class GoogleBody(BaseModel):
    token: str


def utcnow() -> datetime:
    return datetime.now(UTC)


def _related_min_score() -> float:
    try:
        return float(os.getenv("RELATED_MIN_SCORE", "0.7"))
    except ValueError:
        return 0.7


def find_related_cards(user: User, card: Card, limit: int = 3) -> list[dict]:
    """Cards most similar to ``card`` (similarity desc, above min score).

    Searches the user's own decks, excluding the card itself, deleted,
    and suspended cards. Raises when no query vector is available or
    Atlas/a vector index is missing — the endpoint degrades to
    ``unavailable``.
    """
    query_vector = list(card.embedding or [])
    if not query_vector:
        text = embeddings.card_embedding_text(card.front_html, card.back_html)
        query_vector, _ = embeddings.embed_text(text)
    deck_ids = [d.id for d in Deck.objects(owner=user)]
    rows = embeddings.similar_cards(
        Card._get_collection(),
        query_vector,
        exclude_id=card.id,
        deck_ids=deck_ids or None,
        limit=limit,
        min_score=_related_min_score(),
    )
    decks = {d.id: d for d in Deck.objects(id__in=[r["deck"] for r in rows])} if rows else {}
    out = []
    for r in rows:
        deck = decks.get(r["deck"])
        out.append(
            {
                "card_id": str(r["_id"]),
                "front_text": plain_text(r.get("front_html") or ""),
                "deck_name": deck.name if deck else "",
                "score": round(float(r.get("score") or 0), 4),
            }
        )
    return out


# MCP (Streamable HTTP) for external AI clients such as ChatGPT.
# Disable with MCP_ENABLED=0.
_MCP_ENABLED = os.getenv("MCP_ENABLED", "1") == "1"


class _McpDispatch:
    """Stable mount target forwarding to the current lifespan's MCP app.

    The MCP SDK allows a single session-manager run per server instance, so
    each ASGI lifespan gets a fresh sub-app (this also keeps repeated
    TestClient lifespans in the test suite working).
    """

    def __init__(self):
        self.current = None

    async def __call__(self, scope, receive, send):
        assert self.current is not None, "MCP app not initialized"
        await self.current(scope, receive, send)


_mcp_dispatch = _McpDispatch()


@asynccontextmanager
async def lifespan(app: FastAPI):
    mongo_connection.init()
    if not _MCP_ENABLED:
        yield
        return
    # Imported here so MCP_ENABLED=0 avoids importing the mcp package entirely.
    from .mcp_server import create_mcp_server

    sub_app = create_mcp_server().streamable_http_app()
    _mcp_dispatch.current = sub_app
    try:
        # Starlette does not propagate lifespan to mounted sub-apps, so run the
        # MCP session manager's lifespan explicitly.
        async with sub_app.router.lifespan_context(sub_app):
            yield
    finally:
        _mcp_dispatch.current = None


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
    app = FastAPI(title="smarthole", lifespan=lifespan)

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
            cards = list(Card.objects(deck=deck, deleted__ne=True))
            active_ids = [c.id for c in cards if not c.suspended]
            if active_ids:
                due = CardState.objects(
                    user=user, card__in=active_ids, reps__gt=0, due__lte=utcnow()
                ).count()
                new = CardState.objects(user=user, card__in=active_ids, reps=0).count()
                day_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
                due_today = CardState.objects(
                    user=user,
                    card__in=active_ids,
                    reps__gt=0,
                    due__lt=day_start + timedelta(days=1),
                ).count()
            else:
                due = new = due_today = 0
            out.append(
                {
                    "id": str(deck.id),
                    "name": deck.name,
                    "total": len(cards),
                    "due": due,
                    "due_today": due_today,
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
        q: str | None = Query(default=None),
        show_deleted: bool = Query(default=False),
        user: User = Depends(get_current_user),
    ):
        deck = Deck.objects(owner=user, id=deck_id).first()
        if deck is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Deck not found")
        # Default view hides logically deleted cards; show_deleted=True
        # shows *only* deleted cards (for restore / permanent delete).
        # __ne matches pre-migration cards that lack the field entirely.
        if show_deleted:
            cards_query = Card.objects(deck=deck, deleted=True)
        else:
            cards_query = Card.objects(deck=deck, deleted__ne=True)
        if q and q.strip():
            needle = q.strip()
            cards_query = cards_query.filter(
                Q(front_html__icontains=needle) | Q(back_html__icontains=needle)
            )
        card_ids = [c.id for c in cards_query]
        total = (
            CardState.objects(user=user, card__in=card_ids).count() if card_ids else 0
        )
        states = _paged_states(user, card_ids, sort, direction, skip, limit)
        cards = {c.id: c for c in Card.objects(id__in=[s.card.id for s in states])}
        tomorrow = _day_start() + timedelta(days=1)
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
                    "deleted": bool(card.deleted),
                    "due_today": (
                        s.reps > 0
                        and not card.suspended
                        and s.due is not None
                        and fsrs_service.ensure_aware(s.due) < tomorrow
                    ),
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
            front_html=apkg_import.render_plain_text(body.front),
            back_html=apkg_import.render_plain_text(body.back),
            new_position=new_position,
        ).save()
        # Best-effort: a missing key or API failure just leaves the card
        # unembedded until the backfill script runs.
        embeddings.refresh_card_embedding(card)
        CardState(
            user=user,
            card=card,
            new_position=new_position,
            **fsrs_service.fresh_state(),
        ).save()
        return {"card_id": str(card.id), "deck_id": str(deck.id)}

    @app.put("/api/cards/{card_id}")
    def update_card(
        card_id: str, body: CardUpdateBody, user: User = Depends(get_current_user)
    ):
        if not body.front.strip() or not body.back.strip():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "front and back must be non-empty"
            )
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id or card.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        card.update(
            set__front_html=apkg_import.render_plain_text(body.front),
            set__back_html=apkg_import.render_plain_text(body.back),
        )
        card.reload()
        embeddings.refresh_card_embedding(card)
        return {
            "card_id": str(card.id),
            "deck_id": str(card.deck.id),
            "front_html": card.front_html,
            "back_html": card.back_html,
        }

    @app.post("/api/cards/{card_id}/ai-review")
    def ai_review_card(
        card_id: str,
        body: AiReviewBody | None = None,
        user: User = Depends(get_current_user),
    ):
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id or card.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        mode = (body.mode if body else "split") or "split"
        question = (body.question if body else None) or None
        if mode == "custom":
            if not (question or "").strip():
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "A question is required for a custom AI review",
                )
            try:
                answer, model = ai_review.answer_question_with_ai(
                    card.front_html, card.back_html, question.strip()
                )
            except RuntimeError as exc:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)
                ) from exc
            except Exception as exc:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, f"AI review failed: {exc}"
                ) from exc
            return {"answer": answer, "model": model}
        try:
            suggestions, model = ai_review.review_card_with_ai(
                card.front_html, card.back_html
            )
        except RuntimeError as exc:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, f"AI review failed: {exc}"
            ) from exc
        return {"suggestions": suggestions, "model": model}

    @app.get("/api/cards/{card_id}/ai-review/stream")
    def ai_review_stream(
        card_id: str,
        mode: Literal["split", "custom"] = Query(default="split"),
        question: str | None = Query(default=None),
        user: User = Depends(get_current_user),
    ):
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id or card.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        if mode == "custom" and not (question or "").strip():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "A question is required for a custom AI review",
            )
        front_html, back_html = card.front_html, card.back_html
        clean_question = (question or "").strip() or None

        def stream_lines():
            def line(obj) -> bytes:
                return (json.dumps(obj) + "\n").encode("utf-8")

            try:
                chunks: list[str] = []
                for delta in ai_review.stream_review_with_ai(
                    front_html, back_html, mode=mode, question=clean_question
                ):
                    chunks.append(delta)
                    yield line({"delta": delta})
                full = "".join(chunks)
                if mode == "custom":
                    yield line(
                        {
                            "done": True,
                            "answer": full.strip(),
                            "model": ai_review.AI_MODEL,
                        }
                    )
                else:
                    try:
                        suggestions = ai_review.parse_suggestions(full)
                    except Exception as exc:
                        yield line({"error": f"AI reply was not valid JSON: {exc}"})
                        return
                    yield line(
                        {
                            "done": True,
                            "suggestions": suggestions,
                            "model": ai_review.AI_MODEL,
                        }
                    )
            except RuntimeError as exc:
                yield line({"error": str(exc), "status": 503})
            except ValueError as exc:
                yield line({"error": str(exc), "status": 400})
            except Exception as exc:
                yield line({"error": f"AI review failed: {exc}", "status": 502})

        return StreamingResponse(
            stream_lines(), media_type="application/x-ndjson"
        )

    @app.delete("/api/cards/{card_id}")
    def delete_card(
        card_id: str,
        permanent: bool = Query(default=False),
        user: User = Depends(get_current_user),
    ):
        """Delete a card.

        Default is a logical delete (``deleted`` flag): the card, its
        scheduling state, and its review history are all kept so the card
        can be restored. ``?permanent=true`` hard-deletes the card *and*
        its schedule/reviews — the only path that removes that metadata.
        """
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        if permanent:
            CardState.objects(card=card).delete()
            Review.objects(card=card).delete()
            card.delete()
            return {"deleted": card_id, "permanent": True}
        if not card.deleted:
            card.update(set__deleted=True, set__deleted_at=utcnow())
        return {"deleted": card_id, "permanent": False}

    @app.post("/api/cards/{card_id}/restore")
    def restore_card(card_id: str, user: User = Depends(get_current_user)):
        """Undelete a logically deleted card (schedule/history are intact)."""
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        if card.deleted:
            card.update(set__deleted=False, unset__deleted_at=True)
        return {"restored": card_id}

    @app.get("/api/cards/{card_id}")
    def get_card(card_id: str, user: User = Depends(get_current_user)):
        """Full review payload for one card (used to queue a related card)."""
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id or card.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        state = CardState.objects(user=user, card=card).first()
        if state is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No state for this card")
        return _present_state(state)

    @app.get("/api/cards/{card_id}/related")
    def related_cards(
        card_id: str,
        limit: int = Query(default=3, ge=1, le=10),
        user: User = Depends(get_current_user),
    ):
        """Cards most similar to this one, for the review "related" hint.

        Returns only cards at or above RELATED_MIN_SCORE. When embeddings
        are unavailable (no key, no vector index) the list is empty with
        ``unavailable: True`` so the UI can hide the hint.
        """
        try:
            card = Card.objects(id=card_id).first()
        except Exception:
            card = None
        if card is None or card.deck.owner.id != user.id or card.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        try:
            rows = find_related_cards(user, card, limit=limit)
        except Exception as exc:
            logger.warning("related search unavailable: %s", exc)
            return {"cards": [], "unavailable": True}
        return {"cards": rows, "unavailable": False}

    @app.post("/api/import", status_code=201)
    def import_apkg(
        file: UploadFile = File(...),
        stream: bool = Query(default=False),
        user: User = Depends(get_current_user),
    ):
        name = (file.filename or "").lower()
        if not name.endswith((".apkg", ".colpkg")):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Upload a .apkg or .colpkg file"
            )
        with tempfile.NamedTemporaryFile(suffix=".apkg", delete=False) as tmp:
            tmp.write(file.file.read())
            tmp_path = tmp.name

        def run_save(result):
            """Yield ("save", done, total); return the result payload dict."""
            filename_to_url = _store_media(result.media)
            total = sum(len(ideck.cards) for ideck in result.decks)
            done = 0
            imported = 0
            for ideck in result.decks:
                deck = Deck.objects(owner=user, name=ideck.name).first()
                if deck is None:
                    deck = Deck(
                        owner=user, name=ideck.name, source_apkg=file.filename
                    ).save()
                existing = {
                    (c.anki_nid, c.anki_ord): c for c in Card.objects(deck=deck)
                }
                for icard in ideck.cards:
                    key = (icard.anki_nid, icard.anki_ord)
                    old = existing.get(key)
                    if old is None:
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
                    else:
                        if not old.new_position and icard.anki_due:
                            old.update(set__new_position=icard.anki_due)
                            skipped = CardState.objects(user=user, card=old).first()
                            if skipped is not None and not skipped.new_position:
                                skipped.update(set__new_position=icard.anki_due)
                        if icard.suspended != old.suspended:
                            old.update(set__suspended=icard.suspended)
                        if result.scheduling:
                            _refresh_imported_state(user, old, icard)
                    done += 1
                    if done == total or done % apkg_import.PROGRESS_EVERY == 0:
                        yield ("save", done, total)
            return {
                "imported": imported,
                "decks": len(result.decks),
                "scheduling": result.scheduling,
                "due": _review_due_count(user),
            }

        def drain(gen):
            while True:
                try:
                    next(gen)
                except StopIteration as stop:
                    return stop.value

        def stream_lines():
            """NDJSON progress events, ending with a complete (or error) line.

            With ``?stream=true`` the parse and save phases each report cards
            processed, so the import button can show live progress.
            """

            def line(obj) -> bytes:
                return (json.dumps(obj) + "\n").encode("utf-8")

            try:
                yield line({"stage": "upload", "done": 1, "total": 1})
                events = apkg_import.parse_apkg_events(tmp_path)
                while True:
                    try:
                        stage, done, total = next(events)
                    except StopIteration as stop:
                        parsed = stop.value
                        break
                    yield line({"stage": stage, "done": done, "total": total})
                save = run_save(parsed)
                while True:
                    try:
                        _stage, done, total = next(save)
                    except StopIteration as stop:
                        payload = stop.value
                        break
                    yield line({"stage": "save", "done": done, "total": total})
                yield line({"complete": True, "result": payload})
            except Exception as exc:
                yield line({"error": f"Bad package: {exc}"})
            finally:
                Path(tmp_path).unlink(missing_ok=True)

        if stream:
            return StreamingResponse(stream_lines(), media_type="application/x-ndjson")
        try:
            result = apkg_import.parse_apkg(tmp_path)
        except Exception as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Bad package: {exc}"
            ) from exc
        finally:
            Path(tmp_path).unlink(missing_ok=True)
        return drain(run_save(result))

    @app.get("/api/next")
    def next_cards(
        deck_id: str | None = None,
        limit: int = 1,
        exclude: str | None = None,
        user: User = Depends(get_current_user),
    ):
        limit = max(limit, 1)
        deck = None
        if deck_id:
            deck = Deck.objects(owner=user, id=deck_id).first()
            if deck is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Deck not found")
        cards = _active_cards(user, deck)
        if exclude:
            # Lets the client preload the card after the current one: the
            # current card is still due (ungraded), so skip it explicitly.
            cards = {cid: c for cid, c in cards.items() if str(cid) != exclude}
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
        if card is None or card.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
        state = CardState.objects(user=user, card=card).first()
        if state is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No state for this card")
        current = _scheduler_fields(state)
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
        active = {c.id: c for c in cards if not c.suspended and not c.deleted}
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
        visible = [c for c in cards if not c.deleted]
        return {
            "totals": {
                "cards": len(visible),
                "new": new,
                "learning": learning,
                "review": review,
                "suspended": len(visible) - len(active),
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

    if _MCP_ENABLED:
        from mcp.server.auth.routes import create_auth_routes
        from mcp.server.auth.settings import (
            ClientRegistrationOptions,
            RevocationOptions,
        )
        from pydantic import AnyHttpUrl, TypeAdapter

        from .mcp_oauth_provider import SmartholeOAuthProvider
        from .mcp_oauth_routes import router as mcp_oauth_router
        from .mcp_server import MCP_ISSUER_URL as _MCP_ISSUER_URL
        from .mcp_server import MCP_RESOURCE_URL as _MCP_RESOURCE_URL
        from .mcp_server import MCP_SCOPES as _MCP_SCOPES

        _mcp_oauth_provider = SmartholeOAuthProvider(
            resource_url=_MCP_RESOURCE_URL, allowed_scopes=list(_MCP_SCOPES)
        )
        _mcp_issuer = str(TypeAdapter(AnyHttpUrl).validate_python(_MCP_ISSUER_URL))
        for _auth_route in create_auth_routes(
            _mcp_oauth_provider,
            issuer_url=TypeAdapter(AnyHttpUrl).validate_python(_mcp_issuer),
            client_registration_options=ClientRegistrationOptions(
                enabled=True,
                valid_scopes=list(_MCP_SCOPES),
                default_scopes=list(_MCP_SCOPES),
            ),
            revocation_options=RevocationOptions(enabled=True),
        ):
            app.router.routes.append(_auth_route)
        app.include_router(mcp_oauth_router)

        app.mount("/mcp", _mcp_dispatch)

        @app.get("/.well-known/oauth-protected-resource/mcp")
        def mcp_protected_resource_metadata():
            """RFC 9728 metadata so OAuth clients can discover the AS."""
            base = os.getenv(
                "MCP_PUBLIC_BASE_URL", "https://smarthole.cathalanddad.com"
            )
            return {
                "resource": f"{base.rstrip('/')}/mcp",
                "authorization_servers": [_mcp_issuer],
                "scopes_supported": list(_MCP_SCOPES),
                "bearer_methods_supported": ["header"],
            }

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
    """Active (non-suspended, non-deleted) cards by id, scoped to one deck."""
    if deck is not None:
        found = Card.objects(deck=deck, suspended=False, deleted__ne=True)
    else:
        deck_ids = [d.id for d in Deck.objects(owner=user)]
        found = (
            Card.objects(deck__in=deck_ids, suspended=False, deleted__ne=True)
            if deck_ids
            else []
        )
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


_FRONT_ECHO_RE = re.compile(r"\s*<hr\b[^>]*>", re.IGNORECASE)


def strip_front_echo(front_html: str, back_html: str) -> str:
    """Drop the Anki ``{{FrontSide}}`` echo at the start of the answer side.

    Answer templates are usually ``{{FrontSide}}<hr>{{Back}}``, so the stored
    answer begins with a copy of the question. The question is already on
    screen in review mode, so strip that prefix (question + the <hr>) and
    return just the answer. Anything else is returned untouched — in
    particular an answer that merely starts with the same words but has no
    <hr> separator is left alone.
    """
    if not front_html or not back_html:
        return back_html
    if not back_html.startswith(front_html):
        return back_html
    rest = back_html[len(front_html):]
    match = _FRONT_ECHO_RE.match(rest)
    if not match:
        return back_html
    return rest[match.end():]


def _scheduler_fields(state: CardState) -> dict:
    """Scheduler inputs for one card's state (also the preview basis)."""
    return {
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


def _preview_intervals(state: CardState, now: datetime) -> dict:
    """Next-due preview per rating, so the UI can label the grade buttons."""
    current = _scheduler_fields(state)
    previews = {}
    for rating in (1, 2, 3, 4):
        try:
            previews[str(rating)] = fsrs_service.apply_rating(
                current, rating, now
            )["due"].isoformat()
        except Exception:
            continue
    return previews


def _present_state(state: CardState) -> dict:
    """Review payload: card HTML plus full scheduling/metadata for debugging."""
    card = state.card
    return {
        "card_id": str(card.id),
        "deck_id": str(card.deck.id),
        "deck_name": card.deck.name,
        "front_html": card.front_html,
        "back_html": strip_front_echo(card.front_html, card.back_html),
        "due": state.due.isoformat(),
        "state": state.state,
        "reps": state.reps,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "intervals": _preview_intervals(state, utcnow()),
        "meta": {
            "card_id": str(card.id),
            "deck_id": str(card.deck.id),
            "deck_name": card.deck.name,
            "created_at": card.created_at.isoformat() if card.created_at else None,
            "suspended": bool(card.suspended),
            "deleted": bool(card.deleted),
            "deleted_at": card.deleted_at.isoformat() if card.deleted_at else None,
            "new_position": card.new_position,
            "anki_nid": card.anki_nid,
            "anki_ord": card.anki_ord,
            "anki_guid": card.anki_guid,
            "due": state.due.isoformat() if state.due else None,
            "last_review": state.last_review.isoformat()
            if state.last_review
            else None,
            "state": state.state,
            "step": state.step,
            "stability": state.stability,
            "difficulty": state.difficulty,
            "reps": state.reps,
            "lapses": state.lapses,
            "introduced_at": state.introduced_at.isoformat()
            if state.introduced_at
            else None,
        },
    }


app = create_app()
