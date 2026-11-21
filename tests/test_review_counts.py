"""Truthful review counts: new_due per deck and next_due_at in /api/next."""

import os
from datetime import UTC, datetime

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole import fsrs_service
from smarthole.models import Card, CardState, Deck, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_counts_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="counts@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    return User.objects(email=email).first()


def make_deck(client, user, name, count=3):
    deck = Deck(owner=user, name=name).save()
    ids = []
    for n in range(count):
        card = Card(deck=deck, front_html=f"{name} Q{n}", back_html="A").save()
        CardState(
            user=user, card=card, new_position=n + 1, **fsrs_service.fresh_state()
        ).save()
        ids.append(str(card.id))
    return deck, ids


def decks_by_id(client):
    return {d["id"]: d for d in client.get("/api/decks").json()["decks"]}


def test_new_due_tracks_budget(client):
    user = register(client)
    deck, ids = make_deck(client, user, "N")
    assert decks_by_id(client)[str(deck.id)]["new_due"] == 3
    client.put(f"/api/decks/{deck.id}", json={"new_cards_per_day": 1})
    assert decks_by_id(client)[str(deck.id)]["new_due"] == 1
    # Introducing one new card spends the whole budget of 1 (Easy graduates
    # it days out, so nothing remains due either).
    assert client.post(f"/api/review/{ids[0]}", json={"rating": 4}).status_code == 200
    body = decks_by_id(client)[str(deck.id)]
    assert body["new_due"] == 0
    # ...while due reviews are still counted separately.
    assert body["due_today"] == 0
    assert client.get(f"/api/next?deck_id={deck.id}").json()["cards"] == []


def test_next_due_at_points_at_intraday_learning(client):
    user = register(client)
    deck, ids = make_deck(client, user, "L", count=1)
    assert client.get("/api/next").json()["next_due_at"] is None
    assert client.post(f"/api/review/{ids[0]}", json={"rating": 1}).status_code == 200
    body = client.get("/api/next").json()
    assert body["cards"] == []
    assert body["next_due_at"] is not None
    due = datetime.fromisoformat(body["next_due_at"])
    if due.tzinfo is None:
        due = due.replace(tzinfo=UTC)
    delta_min = (due - datetime.now(UTC)).total_seconds() / 60
    assert 0 < delta_min <= 15


def test_today_counts_distinct_studied_cards(client):
    user = register(client)
    _, ids = make_deck(client, user, "T", count=2)
    assert client.get("/api/today").json() == {"studied": 0}
    assert client.post(f"/api/review/{ids[0]}", json={"rating": 3}).status_code == 200
    assert client.post(f"/api/review/{ids[1]}", json={"rating": 2}).status_code == 200
    assert client.post(f"/api/review/{ids[0]}", json={"rating": 3}).status_code == 200
    assert client.get("/api/today").json() == {"studied": 2}


def test_next_due_at_respects_deck_scope(client):
    user = register(client)
    deck_a, ids_a = make_deck(client, user, "A", count=1)
    deck_b, _ = make_deck(client, user, "B", count=1)
    assert client.post(f"/api/review/{ids_a[0]}", json={"rating": 1}).status_code == 200
    scoped = client.get(f"/api/next?deck_id={deck_b.id}").json()
    assert scoped["cards"] != []
    assert scoped["next_due_at"] is None
    assert client.get("/api/next").json()["next_due_at"] is not None
