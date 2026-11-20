"""Tests for the feature_requests.md batch: export echo, browse sort,
feedback, build-info, and MCP viewing/similarity tools."""

import os
from datetime import UTC, datetime, timedelta

os.environ["TESTING"] = "1"
os.environ.setdefault("MCP_ALLOWED_HOSTS", "testserver")
os.environ.setdefault("SECRET_KEY", "test-secret-key")

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole import fsrs_service
from smarthole.models import Card, CardState, Deck, Feedback, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_feature_fixes_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    User.objects.delete()
    Card.objects.delete()
    CardState.objects.delete()
    Deck.objects.delete()
    Feedback.objects.delete()
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="user@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text


def make_deck_with_cards(user, name="Sort Deck", fronts=("A", "B", "C")):
    deck = Deck(owner=user, name=name).save()
    cards = []
    for i, front in enumerate(fronts):
        card = Card(
            deck=deck,
            card_number=(i + 1) * 10,
            front_html=front,
            back_html=f"{front} back",
            new_position=i + 1,
        ).save()
        card.update(
            set__created_at=datetime.now(UTC) - timedelta(days=len(fronts) - i)
        )
        CardState(
            user=user, card=card, new_position=i + 1, **fsrs_service.fresh_state()
        ).save()
        cards.append(card)
    return deck, cards


def test_export_strips_front_echo(client, tmp_path):
    """Exported Back must not repeat the Front (Anki {{FrontSide}} echo)."""
    register(client)
    user = User.objects(email="user@example.com").first()
    deck, _ = make_deck_with_cards(user, fronts=("Q",))
    card = Card.objects(deck=deck).first()
    card.update(set__back_html="Q<hr>A")

    res = client.get(f"/api/export?deck_ids={deck.id}")
    assert res.status_code == 200, res.text
    out = tmp_path / "exported.apkg"
    out.write_bytes(res.content)

    # Read the raw note fields back with Anki's own backend: the Back
    # *field* must hold just the answer ("A"). (The rendered answer always
    # re-adds the FrontSide echo through the Basic template — the app
    # strips that at review time.)
    import contextlib
    import io as _io

    from anki.collection import Collection, ImportAnkiPackageRequest

    workdir = tmp_path / "reimport"
    workdir.mkdir()
    col = Collection(str(workdir / "re.anki2"))
    try:
        request = ImportAnkiPackageRequest()
        request.package_path = str(out)
        with contextlib.redirect_stderr(_io.StringIO()):
            col.import_anki_package(request)
        nids = col.find_notes("")
        assert len(nids) == 1
        note = col.get_note(nids[0])
        assert note["Front"] == "Q"
        assert note["Back"] == "A"
    finally:
        col.close()


def test_browse_sorts_by_created_at_and_card_number(client):
    register(client)
    user = User.objects(email="user@example.com").first()
    deck, _ = make_deck_with_cards(user, fronts=("Old", "Mid", "New"))

    res = client.get(f"/api/decks/{deck.id}/cards?sort=created_at&direction=asc")
    assert res.status_code == 200, res.text
    assert [c["front_text"] for c in res.json()["cards"]] == ["Old", "Mid", "New"]

    res = client.get(f"/api/decks/{deck.id}/cards?sort=created_at&direction=desc")
    assert [c["front_text"] for c in res.json()["cards"]] == ["New", "Mid", "Old"]

    res = client.get(f"/api/decks/{deck.id}/cards?sort=card_number&direction=desc")
    assert res.status_code == 200, res.text
    assert [c["front_text"] for c in res.json()["cards"]] == ["New", "Mid", "Old"]

    res = client.get(f"/api/decks/{deck.id}/cards?sort=card_number&direction=asc")
    assert [c["front_text"] for c in res.json()["cards"]] == ["Old", "Mid", "New"]


def test_feedback_submit_and_own_list(client):
    register(client)
    assert client.post("/api/feedback", json={"text": "  "}).status_code == 400

    res = client.post("/api/feedback", json={"text": "Love it", "screen": "Review"})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["status"] == "submitted"
    assert body["text"] == "Love it"
    assert body["email"] == "user@example.com"

    res = client.get("/api/feedback")
    assert res.status_code == 200, res.text
    assert [f["text"] for f in res.json()["feedback"]] == ["Love it"]


def test_feedback_admin_all_filter_patch_export(client):
    register(client, "user@example.com")
    register(client, "admin@example.com")
    admin = User.objects(email="admin@example.com").first()
    admin.update(set__name="Admin User")

    import smarthole.app as app_mod

    old = os.getenv("ADMIN_EMAILS")
    os.environ["ADMIN_EMAILS"] = "admin@example.com"
    try:
        # Regular user cannot see everyone's feedback.
        user_client_user = client
        user_client_user.post("/api/login", json={"email": "user@example.com", "password": "secret123"})
        assert user_client_user.get("/api/feedback/all").status_code == 403
        assert user_client_user.get("/api/feedback/export").status_code == 403
        user_client_user.post("/api/feedback", json={"text": "user note"})
        # Log back in as admin for the rest.
        client.post(
            "/api/login",
            json={"email": "admin@example.com", "password": "secret123"},
        )
        client.post("/api/feedback", json={"text": "admin note"})

        res = client.get("/api/feedback/all")
        assert res.status_code == 200, res.text
        got = res.json()["feedback"]
        assert len(got) == 2
        # Admin sees usernames (empty string when the user never set a name).
        by_email = {f["email"]: f for f in got}
        assert by_email["admin@example.com"]["username"] == "Admin User"

        res = client.get("/api/feedback/all?email=user")
        assert [f["email"] for f in res.json()["feedback"]] == ["user@example.com"]

        fb_id = by_email["user@example.com"]["id"]
        res = client.patch(f"/api/feedback/{fb_id}", json={"status": "resolved"})
        assert res.status_code == 200, res.text
        assert res.json()["status"] == "resolved"
        assert client.patch(f"/api/feedback/{fb_id}", json={"status": "bogus"}).status_code == 400
        assert client.patch("/api/feedback/000000000000000000000000", json={"status": "resolved"}).status_code == 404

        res = client.get("/api/feedback/all?status=submitted")
        assert [f["email"] for f in res.json()["feedback"]] == ["admin@example.com"]

        res = client.get("/api/feedback/export?status=resolved")
        assert res.status_code == 200, res.text
        assert res.headers["content-type"].startswith("text/csv")
        assert "user note" in res.text
        assert "admin note" not in res.text
    finally:
        if old is None:
            os.environ.pop("ADMIN_EMAILS", None)
        else:
            os.environ["ADMIN_EMAILS"] = old
    assert app_mod._admin_emails() == {"anthonynolan@gmail.com"}


def test_build_info_reports_server_start(client):
    register(client)
    res = client.get("/api/build-info")
    assert res.status_code == 200, res.text
    body = res.json()
    datetime.fromisoformat(body["server_started_at"])
    assert "server_git_sha" in body
