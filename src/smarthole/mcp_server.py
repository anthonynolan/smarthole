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

from . import apkg_import, fsrs_service
from .mcp_auth import (
    CARDS_READ_SCOPE,
    CARDS_WRITE_SCOPE,
    MCP_SCOPES,
    SmartholeTokenVerifier,
)
from .models import Card, CardState, Deck, User

__all__ = ["mcp", "create_mcp_server", "MCP_SCOPES"]


class CreateCardResult(TypedDict):
    """Structured result for create_card: ids of the new card and its deck."""

    card_id: str
    deck_id: str


logger = logging.getLogger(__name__)

MCP_RESOURCE_URL = os.getenv(
    "MCP_RESOURCE_URL", "https://smarthole.cathalanddad.com/mcp"
)
MCP_ISSUER_URL = os.getenv("MCP_ISSUER_URL", "https://smarthole.cathalanddad.com")
MCP_STATELESS = os.getenv("MCP_STATELESS", "0") == "1"

MCP_INSTRUCTIONS = """Use smarthole tools for the authenticated user's Anki
decks. To add cards: call list_decks first so you use a real deck_id (and the
exact deck name the user asked for), then call create_card once per card.
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


def create_card(deck_id: str, front: str, back: str) -> CreateCardResult:
    """Create one Anki card in the caller's deck.

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
        try:
            deck = Deck.objects(owner=user, id=deck_id).first()
        except Exception:
            deck = None
        if deck is None:
            raise ToolError("Deck not found")
        existing = Card.objects(deck=deck).only("new_position")
        new_position = max((c.new_position or 0 for c in existing), default=0) + 1
        card = Card(
            deck=deck,
            front_html=apkg_import.sanitize(front),
            back_html=apkg_import.sanitize(back),
            new_position=new_position,
        ).save()
        CardState(
            user=user,
            card=card,
            new_position=new_position,
            **fsrs_service.fresh_state(),
        ).save()
        return {"card_id": str(card.id), "deck_id": str(deck.id)}

    return _call_service("create_card", _create, user_email)


_MCP_TOOLS = (list_decks, create_card)

_MCP_TOOL_META: dict[str, dict] = {
    "create_card": {
        "openai/toolInvocation/invoking": "Adding your Anki card…",
        "openai/toolInvocation/invoked": "Card added",
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
    return server


mcp = create_mcp_server()
