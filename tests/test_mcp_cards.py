"""MCP tests: deck listing + card creation over Streamable HTTP + OAuth wiring."""

import json
import os

os.environ["TESTING"] = "1"
os.environ.setdefault("MCP_ALLOWED_HOSTS", "testserver")
os.environ.setdefault("SECRET_KEY", "test-secret-key")

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole import mcp_server
from smarthole.mcp_oauth_provider import mint_access_token
from smarthole.models import Card, Deck, User

USER_EMAIL = "mcp-test@example.com"


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_mcp_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    User.objects(email=USER_EMAIL).delete()
    User(email=USER_EMAIL).save()
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def _bearer(email=USER_EMAIL, scopes=None):
    scopes = scopes if scopes is not None else list(mcp_server.MCP_SCOPES)
    token, _jti, _exp = mint_access_token(
        email, scopes, mcp_server.MCP_RESOURCE_URL, "test-client"
    )
    return token


def _mcp_rpc(client, payload, token, session=None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if session:
        headers["mcp-session-id"] = session
    res = client.post("/mcp/", headers=headers, json=payload)
    assert res.status_code in (200, 202), res.text[:300]
    for line in res.text.splitlines():
        if line.startswith("data: "):
            try:
                return json.loads(line[6:]), res.headers.get("mcp-session-id")
            except Exception:
                continue
    return None, res.headers.get("mcp-session-id")


def _init_session(client, token):
    body, session = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
        },
        token,
    )
    assert session, "expected MCP session id"
    assert body["result"]["serverInfo"]["name"] == "smarthole"
    return session


def test_mcp_endpoint_requires_bearer(client):
    res = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
        },
    )
    assert res.status_code == 401
    assert "oauth-protected-resource" in res.headers.get("www-authenticate", "")


def test_mcp_tools_registered():
    names = {t.name for t in mcp_server.mcp._tool_manager.list_tools()}
    assert {"list_decks", "create_card", "propose_cards", "create_cards"} <= names


def test_mcp_propose_then_create_roundtrip(client):
    """Checkbox flow: propose writes nothing, create_cards writes flagged cards."""
    user = User.objects(email=USER_EMAIL).first()
    deck = Deck(owner=user, name="Propose Deck").save()
    token = _bearer()
    session = _init_session(client, token)

    before = Card.objects(deck=deck).count()
    proposed, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "propose_cards",
                "arguments": {
                    "deck_id": str(deck.id),
                    "cards": [
                        {"front": "P front 1", "back": "P back 1"},
                        {"front": "P front 2", "back": "P back 2"},
                    ],
                },
            },
        },
        token,
        session,
    )
    assert proposed["result"]["structuredContent"]["deck_id"] == str(deck.id)
    assert len(proposed["result"]["structuredContent"]["cards"]) == 2
    # Proposal alone creates nothing (widget confirmation still pending).
    assert Card.objects(deck=deck).count() == before

    created, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "create_cards",
                "arguments": {
                    "deck_id": str(deck.id),
                    "cards": [{"front": "P front 1", "back": "P back 1"}],
                },
            },
        },
        token,
        session,
    )
    content = created["result"]["structuredContent"]
    assert content["count"] == 1
    card = Card.objects(id=content["created_card_ids"][0]).first()
    assert card is not None
    assert card.created_via_mcp is True
    assert "P front 1" in card.front_html


def test_mcp_create_flags_card_for_browse_filter(client):
    """Direct MCP creates are flagged so Browse's MCP checkbox finds them."""
    user = User.objects(email=USER_EMAIL).first()
    deck = Deck(owner=user, name="Flag Deck").save()
    token = _bearer()
    session = _init_session(client, token)

    created_body, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {
                "name": "create_card",
                "arguments": {
                    "deck_id": str(deck.id),
                    "front": "flag me",
                    "back": "flag back",
                },
            },
        },
        token,
        session,
    )
    card_id = created_body["result"]["structuredContent"]["card_id"]
    assert Card.objects(id=card_id).first().created_via_mcp is True


def test_mcp_list_and_create_roundtrip(client):
    user = User.objects(email=USER_EMAIL).first()
    deck = Deck(owner=user, name="MCP Deck").save()
    token = _bearer()
    session = _init_session(client, token)

    listed, _ = _mcp_rpc(
        client, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, token, session
    )
    names = [t["name"] for t in listed["result"]["tools"]]
    assert "list_decks" in names and "create_card" in names

    decks_body, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "list_decks", "arguments": {}},
        },
        token,
        session,
    )
    decks = decks_body["result"]["structuredContent"]["result"]
    assert any(d["deck_id"] == str(deck.id) and d["name"] == "MCP Deck" for d in decks)

    created_body, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "create_card",
                "arguments": {
                    "deck_id": str(deck.id),
                    "front": "MCP front",
                    "back": "MCP back",
                },
            },
        },
        token,
        session,
    )
    card_id = created_body["result"]["structuredContent"]["card_id"]
    card = Card.objects(id=card_id).first()
    assert card is not None
    assert "MCP front" in card.front_html
    assert "MCP back" in card.back_html


def test_mcp_create_requires_write_scope(client):
    user = User.objects(email=USER_EMAIL).first()
    deck = Deck(owner=user, name="Scoped").save()
    token = _bearer(scopes=["cards:read"])
    session = _init_session(client, token)

    body, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "create_card",
                "arguments": {
                    "deck_id": str(deck.id),
                    "front": "x",
                    "back": "y",
                },
            },
        },
        token,
        session,
    )
    assert "Insufficient scope" in str(body)


def test_mcp_create_rejects_empty_and_unknown_deck(client):
    token = _bearer()
    session = _init_session(client, token)

    empty, _ = _mcp_rpc(
        client,
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "create_card",
                "arguments": {
                    "deck_id": "000000000000000000000000",
                    "front": "  ",
                    "back": "y",
                },
            },
        },
        token,
        session,
    )
    assert "non-empty" in str(empty) or "Deck not found" in str(empty)


def test_mcp_oauth_metadata_and_login_page(client):
    meta = client.get("/.well-known/oauth-protected-resource/mcp")
    assert meta.status_code == 200, meta.text
    body = meta.json()
    assert body["resource"].endswith("/mcp")
    assert body["scopes_supported"] == ["cards:read", "cards:write"]

    assert client.get("/oauth/mcp-login?ticket=nope").status_code == 400
