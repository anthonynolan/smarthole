"""smarthole MCP server: list decks + create cards over Streamable HTTP.

Mounted at ``/mcp`` by :mod:`smarthole.app` when ``MCP_ENABLED=1``.
Authentication uses :class:`mcp_auth.SmartholeTokenVerifier`; tools resolve
the caller's identity via ``get_access_token().subject`` (the smarthole
user email) and never accept a client-supplied user id.

Use :func:`create_mcp_server` to build instances: each ASGI lifespan needs
its own session manager (the SDK forbids running one twice), so app creates
a fresh instance per lifespan while tests share the module-level :data:`mcp`.
"""

from __future__ import annotations

import logging
import os
from typing import TypedDict
from urllib.parse import urlparse

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.server import TransportSecuritySettings
from mongoengine import Q

from . import apkg_import, embeddings, fsrs_service
from .mcp_auth import (
    CARDS_READ_SCOPE,
    CARDS_WRITE_SCOPE,
    MCP_SCOPES,
    SmartholeTokenVerifier,
)
from .mcp_card_widget import WIDGET_MIME, WIDGET_URI, get_card_widget_html
from .models import Card, CardState, Deck, User, next_card_number

__all__ = ["mcp", "create_mcp_server", "MCP_SCOPES"]


class CreateCardResult(TypedDict):
    """Structured result for create_card: ids of the new card and its deck."""

    card_id: str
    deck_id: str


class CardProposalResult(TypedDict):
    """Structured result for propose_cards: deck plus proposed front/back pairs."""

    deck_id: str
    deck_name: str
    cards: list[dict]


class CreateCardsResult(TypedDict):
    """Structured result for create_cards: ids of the new cards and their deck."""

    deck_id: str
    created_card_ids: list[str]
    count: int


logger = logging.getLogger(__name__)

MCP_RESOURCE_URL = os.getenv(
    "MCP_RESOURCE_URL", "https://smarthole.cathalanddad.com/mcp"
)
MCP_ISSUER_URL = os.getenv("MCP_ISSUER_URL", "https://smarthole.cathalanddad.com")
MCP_STATELESS = os.getenv("MCP_STATELESS", "0") == "1"

MCP_INSTRUCTIONS = """Use smarthole tools for the authenticated user's Anki
decks. Use list_cards to view existing cards (and find_similar_cards for
similarity search) before proposing anything, so you do not duplicate what
is already there. For every request to add cards, follow this complete
workflow without exception:
1. Call list_decks first so you use a real deck_id (and the exact deck name
   the user asked for).
2. Decide the card list — final or draft, complete or partial.
3. Call propose_cards with that list before finishing your response, every
   time you present cards (drafts and partial lists included). Never present
   card additions as text alone; propose_cards is required because it renders
   the selectable card UI (checkboxes + select-all). The widget calls
   create_cards with only the ticked boxes, so cards are never created in
   the background. Never call create_card(s) directly to bypass the checkbox
   verification.
Keep front/back short plain text or simple HTML; do not invent deck ids."""


def _allowed_hosts() -> list[str]:
    extra = [
        h.strip() for h in os.getenv("MCP_ALLOWED_HOSTS", "").split(",") if h.strip()
    ]
    return list(
        dict.fromkeys(
            [urlparse(MCP_RESOURCE_URL).hostname or ""]
            + ["localhost", "127.0.0.1", "localhost:*", "127.0.0.1:*"]
            + extra
        )
    )


def _allowed_origins() -> list[str]:
    extra = [
        o.strip() for o in os.getenv("MCP_ALLOWED_ORIGINS", "").split(",") if o.strip()
    ]
    return list(dict.fromkeys(extra))


def _require_auth(*required_scopes: str) -> str:
    token = get_access_token()
    if token is None or not token.subject:
        raise ToolError("Not authenticated. Provide a valid smarthole Bearer token")
    missing = [s for s in required_scopes if s not in (token.scopes or [])]
    if missing:
        raise ToolError(f"Insufficient scope. Required scope: {missing[0]}")
    return token.subject


def _call_service(label: str, func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except PermissionError as e:
        raise ToolError(f"Forbidden: {e}") from e
    except ToolError:
        raise
    except Exception as e:
        logger.error("MCP tool %s failed: %s", label, str(e))
        raise ToolError(f"{label} failed: {str(e)}") from e


def _get_user(email: str) -> User:
    user = User.objects(email=email).first()
    if user is None:
        raise ToolError("Account unavailable")
    return user


def list_decks() -> list[dict]:
    """List the caller's decks with card counts.

    Call this first to resolve the deck_id for create_card.
    """
    user_email = _require_auth(CARDS_READ_SCOPE)
    logger.info("MCP list_decks called")

    def _list(email: str) -> list[dict]:
        user = _get_user(email)
        out = []
        for deck in Deck.objects(owner=user):
            total = Card.objects(deck=deck).count()
            out.append({"deck_id": str(deck.id), "name": deck.name, "total": total})
        return sorted(out, key=lambda d: d["name"].lower())

    return _call_service("list_decks", _list, user_email)


def list_cards(
    deck_id: str, query: str | None = None, limit: int = 50
) -> list[dict]:
    """View the caller's existing cards in a deck, optionally filtered by text.

    Call this before proposing new cards so you do not duplicate what is
    already there. Substring match on the front/back text, newest first.

    Args:
        deck_id: Deck id from list_decks (required).
        query: Optional substring filter on the card text.
        limit: Max cards to return (1-100, default 50).
    """
    user_email = _require_auth(CARDS_READ_SCOPE)
    logger.info("MCP list_cards called")

    def _list(email: str) -> list[dict]:
        user = _get_user(email)
        deck = _resolve_deck(user, deck_id)
        cards_query = Card.objects(deck=deck, deleted__ne=True)
        needle = (query or "").strip()
        if needle:
            cards_query = cards_query.filter(
                Q(front_html__icontains=needle) | Q(back_html__icontains=needle)
            )
        out = []
        for card in cards_query.order_by("-created_at").limit(
            max(1, min(limit, 100))
        ):
            out.append(
                {
                    "card_id": str(card.id),
                    "front_text": apkg_import.html_to_text(card.front_html or "")[
                        :500
                    ],
                    "back_text": apkg_import.html_to_text(card.back_html or "")[
                        :500
                    ],
                    "suspended": bool(card.suspended),
                }
            )
        return out

    return _call_service("list_cards", _list, user_email)


def find_similar_cards(
    text: str | None = None,
    card_id: str | None = None,
    deck_id: str | None = None,
    limit: int = 5,
) -> list[dict]:
    """Similarity search over the caller's existing cards.

    Give either `text` (free query) or `card_id` (cards like this one).
    Scores at/above the server's RELATED_MIN_SCORE threshold come back
    most-similar first. Unavailable when embeddings are not configured.

    Args:
        text: Free-text query (alternative to card_id).
        card_id: Reference card id (alternative to text).
        deck_id: Optional deck id from list_decks to search within.
        limit: Max cards to return (1-20, default 5).
    """
    user_email = _require_auth(CARDS_READ_SCOPE)
    logger.info("MCP find_similar_cards called")

    def _find(email: str) -> list[dict]:
        from .app import _related_min_score

        user = _get_user(email)
        if card_id:
            try:
                ref = Card.objects(id=card_id).first()
            except Exception:
                ref = None
            if ref is None or ref.deck.owner.id != user.id or ref.deleted:
                raise ToolError("Card not found")
            needle_text = embeddings.card_embedding_text(
                ref.front_html, ref.back_html
            )
            exclude = ref.id
        elif (text or "").strip():
            needle_text = text.strip()
            exclude = None
        else:
            raise ToolError("Provide text or card_id to search with")
        try:
            query_vector, _ = embeddings.embed_text(needle_text)
        except Exception as exc:
            raise ToolError(
                "Similarity search is unavailable "
                "(embeddings or the vector index are not configured)"
            ) from exc
        if deck_id:
            deck = _resolve_deck(user, deck_id)
            deck_ids = [deck.id]
        else:
            deck_ids = [d.id for d in Deck.objects(owner=user)]
        try:
            rows = embeddings.similar_cards(
                Card._get_collection(),
                query_vector,
                exclude_id=exclude,
                deck_ids=deck_ids or None,
                limit=max(1, min(limit, 20)),
                min_score=_related_min_score(),
            )
        except Exception as exc:
            raise ToolError(
                "Similarity search is unavailable "
                "(embeddings or the vector index are not configured)"
            ) from exc
        decks = (
            {d.id: d for d in Deck.objects(id__in=[r["deck"] for r in rows])}
            if rows
            else {}
        )
        out = []
        for r in rows:
            deck = decks.get(r["deck"])
            out.append(
                {
                    "card_id": str(r["_id"]),
                    "front_text": (r.get("front_html") or "")[:500],
                    "deck_name": deck.name if deck else "",
                    "score": round(float(r.get("score") or 0), 4),
                }
            )
        return out

    return _call_service("find_similar_cards", _find, user_email)


def _persist_card(user, deck, front: str, back: str) -> Card:
    """Create one MCP-sourced card + fresh FSRS state (no validation)."""
    existing = Card.objects(deck=deck).only("new_position")
    new_position = max((c.new_position or 0 for c in existing), default=0) + 1
    card = Card(
        deck=deck,
        card_number=next_card_number(),
        front_html=apkg_import.sanitize(front),
        back_html=apkg_import.sanitize(back),
        new_position=new_position,
        created_via_mcp=True,
    ).save()
    CardState(
        user=user,
        card=card,
        new_position=new_position,
        **fsrs_service.fresh_state(),
    ).save()
    return card


def _resolve_deck(user, deck_id: str) -> Deck:
    try:
        deck = Deck.objects(owner=user, id=deck_id).first()
    except Exception:
        deck = None
    if deck is None:
        raise ToolError("Deck not found")
    return deck


def create_card(deck_id: str, front: str, back: str) -> CreateCardResult:
    """Create one Anki card in the caller's deck (direct write, no widget).

    Prefer propose_cards so the user verifies with checkboxes; this stays
    for backwards compatibility and still flags the card as MCP-created.

    Args:
        deck_id: Deck id from list_decks (required).
        front: Card front (required, non-empty; plain text or simple HTML).
        back: Card back (required, non-empty; plain text or simple HTML).
    """
    user_email = _require_auth(CARDS_WRITE_SCOPE)
    logger.info("MCP create_card called")

    def _create(email: str) -> dict:
        if not (front or "").strip() or not (back or "").strip():
            raise ToolError("front and back must be non-empty")
        user = _get_user(email)
        deck = _resolve_deck(user, deck_id)
        card = _persist_card(user, deck, front, back)
        return {"card_id": str(card.id), "deck_id": str(deck.id)}

    return _call_service("create_card", _create, user_email)


def propose_cards(deck_id: str, cards: list[dict]) -> CardProposalResult:
    """Present a card list as a selectable widget (call every time).

    After deciding the cards but before finishing your response, call this
    with the list — final, draft, or partial. This call renders the checkbox
    widget (with select-all), so its cards must exactly match what you
    present. Nothing is written: the widget calls create_cards with the
    ticked boxes. Gather context with list_decks / list_cards first.

    Args:
        deck_id: Deck id from list_decks (required).
        cards: Proposed cards, each {"front": "...", "back": "..."}
            (required, non-empty; plain text or simple HTML).
    """
    user_email = _require_auth(CARDS_WRITE_SCOPE)
    logger.info(
        "MCP propose_cards called with %d cards", len(cards or [])
    )

    def _propose(email: str) -> dict:
        if not cards:
            raise ToolError("cards must be a non-empty list")
        user = _get_user(email)
        deck = _resolve_deck(user, deck_id)
        cleaned: list[dict] = []
        for entry in cards:
            front = (entry.get("front") or "") if isinstance(entry, dict) else ""
            back = (entry.get("back") or "") if isinstance(entry, dict) else ""
            if not front.strip() or not back.strip():
                raise ToolError("every card front and back must be non-empty")
            cleaned.append({"front": front, "back": back})
        return {
            "deck_id": str(deck.id),
            "deck_name": deck.name,
            "cards": cleaned,
        }

    return _call_service("propose_cards", _propose, user_email)


def create_cards(deck_id: str, cards: list[dict]) -> CreateCardsResult:
    """Create the user-selected cards from propose_cards.

    The widget behind propose_cards calls this with the ticked boxes.
    Each entry is {"front": "...", "back": "..."}; empty entries are
    rejected and nothing is created for them.

    Args:
        deck_id: Deck id from list_decks (required).
        cards: Selected entries from propose_cards.
    """
    user_email = _require_auth(CARDS_WRITE_SCOPE)
    logger.info(
        "MCP create_cards called with %d cards", len(cards or [])
    )

    def _create_many(email: str) -> dict:
        if not cards:
            raise ToolError("cards must be a non-empty list")
        user = _get_user(email)
        deck = _resolve_deck(user, deck_id)
        ids: list[str] = []
        for entry in cards:
            front = (entry.get("front") or "") if isinstance(entry, dict) else ""
            back = (entry.get("back") or "") if isinstance(entry, dict) else ""
            if not front.strip() or not back.strip():
                raise ToolError("every card front and back must be non-empty")
            ids.append(str(_persist_card(user, deck, front, back).id))
        return {
            "deck_id": str(deck.id),
            "created_card_ids": ids,
            "count": len(ids),
        }

    return _call_service("create_cards", _create_many, user_email)


def card_proposal_widget() -> str:
    """Selectable card-proposal widget (select-all + add to its deck)."""
    return get_card_widget_html()


_MCP_TOOLS = (
    list_decks,
    list_cards,
    find_similar_cards,
    create_card,
    propose_cards,
    create_cards,
)

_CARD_WIDGET_META = {
    "ui": {
        "resourceUri": WIDGET_URI,
        "visibility": ["model", "app"],
    },
    "openai/outputTemplate": WIDGET_URI,
    "openai/toolInvocation/invoking": "Preparing your card suggestions…",
    "openai/toolInvocation/invoked": "Card suggestions ready",
}
_MCP_TOOL_META: dict[str, dict] = {
    "create_card": {
        "openai/toolInvocation/invoking": "Adding your Anki card…",
        "openai/toolInvocation/invoked": "Card added",
    },
    "propose_cards": _CARD_WIDGET_META,
    "create_cards": {
        "ui": {"visibility": ["model", "app"]},
    },
}


def create_mcp_server() -> FastMCP:
    """Build a smarthole FastMCP instance with deck/card tools."""
    server = FastMCP(
        "smarthole",
        instructions=MCP_INSTRUCTIONS,
        token_verifier=SmartholeTokenVerifier(resource_url=MCP_RESOURCE_URL),
        auth=AuthSettings(
            issuer_url=MCP_ISSUER_URL,  # type: ignore[arg-type]
            resource_server_url=MCP_RESOURCE_URL,  # type: ignore[arg-type]
            required_scopes=[],
        ),
        stateless_http=MCP_STATELESS,
        streamable_http_path="/",
        transport_security=TransportSecuritySettings(
            allowed_hosts=_allowed_hosts(),
            allowed_origins=_allowed_origins(),
        ),
    )
    for func in _MCP_TOOLS:
        meta = _MCP_TOOL_META.get(getattr(func, "__name__", ""))
        if meta:
            server.tool(meta=meta)(func)
        else:
            server.tool()(func)
    server.resource(
        WIDGET_URI,
        mime_type=WIDGET_MIME,
        meta={"ui": {"prefersBorder": True}},
    )(card_proposal_widget)
    return server


mcp = create_mcp_server()
