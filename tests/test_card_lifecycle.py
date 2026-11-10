"""Card lifecycle: formatting round-trip, logical/permanent delete, FSRS waves."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_lifecycle_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client):
    res = client.post(
        "/api/register",
        json={"email": "user@example.com", "password": "secret123"},
    )
    assert res.status_code == 201, res.text


def _own_deck(client):
    from smarthole.models import Deck, User

    user = User.objects(email="user@example.com").first()
    return Deck(owner=user, name="D").save()


def _make_card(client, front="Q", back="A"):
    deck = _own_deck(client)
    res = client.post(
        "/api/cards",
        json={"deck_id": str(deck.id), "front": front, "back": back},
    )
    assert res.status_code == 201, res.text
    return deck, res.json()["card_id"]


def test_render_plain_text_keeps_breaks_and_markdown():
    from smarthole.apkg_import import html_to_text, render_plain_text

    html = render_plain_text("Line one\nLine two\n\n**bold** and *ital* and `code`")
    assert "<br>" in html
    assert "<strong>bold</strong>" in html
    assert "<em>ital</em>" in html
    assert "<code>code</code>" in html
    # Round-trip back to editable text preserves the breaks.
    assert html_to_text(html) == "Line one\nLine two\n\nbold and ital and code"


def test_render_plain_text_keeps_real_tags_but_escapes_rest():
    from smarthole.apkg_import import render_plain_text

    html = render_plain_text('<b>hi</b> and <script>evil()</script> and a < b')
    assert "<b>hi</b>" in html
    assert "script" not in html
    assert "< b" not in html  # stray markup is escaped, not rendered


def test_edit_round_trip_preserves_linebreaks(client):
    register(client)
    _, card_id = _make_card(client)
    res = client.put(
        f"/api/cards/{card_id}",
        json={"front": "First line\nSecond line\n\nThird", "back": "B"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["front_html"].count("<br>") >= 2


def test_next_includes_full_metadata(client):
    register(client)
    _, card_id = _make_card(client)
    cards = client.get("/api/next?limit=1").json()["cards"]
    assert cards, "expected the new card to be due"
    meta = cards[0]["meta"]
    assert meta["card_id"] == card_id
    for key in (
        "deck_name",
        "created_at",
        "suspended",
        "deleted",
        "new_position",
        "anki_nid",
        "due",
        "state",
        "stability",
        "difficulty",
        "reps",
        "lapses",
    ):
        assert key in meta, f"missing metadata field {key}"


def test_delete_is_logical_and_browse_hides_it(client):
    from smarthole.models import Card, CardState, Review

    register(client)
    deck, card_id = _make_card(client)
    card = Card.objects(id=card_id).first()
    # Give it scheduling state + review history like a studied card.
    state = CardState.objects(card=card).first()
    state.update(set__reps=3)
    Review(user=card.deck.owner, card=card, rating=3, next_due=state.due).save()

    res = client.delete(f"/api/cards/{card_id}")
    assert res.status_code == 200, res.text
    assert res.json()["permanent"] is False

    # Nothing is purged: card, state, and reviews all survive.
    assert Card.objects(id=card_id).first() is not None
    assert Card.objects(id=card_id).first().deleted is True
    assert CardState.objects(card=card).first() is not None
    assert Review.objects(card=card).count() == 1

    # Hidden from review queue, deck counts, and default browse...
    assert client.get("/api/next?limit=1").json()["cards"] == []
    assert client.get("/api/decks").json()["decks"][0]["total"] == 0
    assert client.get(f"/api/decks/{deck.id}/cards").json() == {"cards": [], "total": 0}
    # ...but listed alone in show_deleted mode.
    shown = client.get(f"/api/decks/{deck.id}/cards?show_deleted=true").json()
    assert [r["card_id"] for r in shown["cards"]] == [card_id]

    # Deleted cards reject review/edit/AI traffic.
    assert client.post(f"/api/review/{card_id}", json={"rating": 3}).status_code == 404
    assert client.put(f"/api/cards/{card_id}", json={"front": "Q", "back": "B"}).status_code == 404

    # Restore brings it back with schedule intact.
    res = client.post(f"/api/cards/{card_id}/restore")
    assert res.status_code == 200, res.text
    assert CardState.objects(card=card).first() is not None
    assert client.get(f"/api/decks/{deck.id}/cards").json()["total"] == 1


def test_permanent_delete_purges_schedule_and_reviews(client):
    from smarthole.models import Card, CardState, Review

    register(client)
    _, card_id = _make_card(client)
    card = Card.objects(id=card_id).first()
    state = CardState.objects(card=card).first()
    Review(user=card.deck.owner, card=card, rating=3, next_due=state.due).save()

    res = client.delete(f"/api/cards/{card_id}?permanent=true")
    assert res.status_code == 200, res.text
    assert res.json()["permanent"] is True
    assert Card.objects(id=card_id).first() is None
    assert CardState.objects(card=card).count() == 0
    assert Review.objects(card=card).count() == 0


def test_single_wave_per_day(client):
    """Grading never leaves a card due again the same day."""
    from datetime import UTC, datetime, timedelta

    from smarthole import fsrs_service
    from smarthole.fsrs_service import ensure_aware

    now = datetime.now(UTC)
    tomorrow = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    for rating in (1, 2, 3, 4):
        updated = fsrs_service.apply_rating(
            fsrs_service.fresh_state(now=now), rating, now=now
        )
        assert ensure_aware(updated["due"]) >= tomorrow, rating
