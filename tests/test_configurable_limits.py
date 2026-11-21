"""Configurable limits: per-deck budgets, new-card order, learning steps."""

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
        "smarthole_limits_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="limits@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    return User.objects(email=email).first()


def make_deck(client, user, name, count=2):
    deck = Deck(owner=user, name=name).save()
    ids = []
    for n in range(count):
        card = Card(deck=deck, front_html=f"{name} Q{n}", back_html="A").save()
        CardState(
            user=user, card=card, new_position=n + 1, **fsrs_service.fresh_state()
        ).save()
        ids.append(str(card.id))
    return deck, ids


def test_deck_settings_roundtrip_and_validation(client):
    user = register(client)
    deck, _ = make_deck(client, user, "D")
    row = next(d for d in client.get("/api/decks").json()["decks"] if d["id"] == str(deck.id))
    assert row["new_cards_per_day"] is None
    assert row["new_order"] == "position"
    assert row["new_limit"] == fsrs_service.NEW_CARDS_PER_DAY

    res = client.put(
        f"/api/decks/{deck.id}",
        json={"new_cards_per_day": 5, "new_order": "newest"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["new_limit"] == 5
    assert res.json()["new_order"] == "newest"

    # 0 resets to the default.
    res = client.put(f"/api/decks/{deck.id}", json={"new_cards_per_day": 0})
    assert res.json()["new_cards_per_day"] is None
    assert res.json()["new_limit"] == fsrs_service.NEW_CARDS_PER_DAY

    assert client.put(f"/api/decks/{deck.id}", json={"new_cards_per_day": -1}).status_code == 400
    assert client.put(f"/api/decks/{deck.id}", json={"new_cards_per_day": 1001}).status_code == 400
    assert client.put(f"/api/decks/{deck.id}", json={"new_order": "random"}).status_code == 400
    assert (
        client.put("/api/decks/000000000000000000000000", json={"new_cards_per_day": 5}).status_code
        == 404
    )


def test_per_deck_budget_is_independent(client):
    user = register(client)
    deck_a, ids_a = make_deck(client, user, "A")
    deck_b, _ = make_deck(client, user, "B")
    client.put(f"/api/decks/{deck_a.id}", json={"new_cards_per_day": 1})
    # Introduce one new card in A: its budget is spent.
    assert client.post(f"/api/review/{ids_a[0]}", json={"rating": 3}).status_code == 200
    assert client.get(f"/api/next?deck_id={deck_a.id}&limit=10").json()["cards"] == []
    # B still has its full default budget.
    assert len(client.get(f"/api/next?deck_id={deck_b.id}&limit=10").json()["cards"]) == 2


def test_newest_first_order(client):
    user = register(client)
    deck, _ = make_deck(client, user, "N", count=3)
    cards = list(Card.objects(deck=deck).order_by("created_at"))
    assert len(cards) == 3
    # Deck order serves the oldest-positioned card first.
    first = client.get(f"/api/next?deck_id={deck.id}").json()["cards"][0]
    assert first["card_id"] == str(cards[0].id)
    client.put(f"/api/decks/{deck.id}", json={"new_order": "newest"})
    first = client.get(f"/api/next?deck_id={deck.id}").json()["cards"][0]
    assert first["card_id"] == str(cards[-1].id)


def test_learning_steps_change_scheduling(client):
    user = register(client)
    deck, ids = make_deck(client, user, "L", count=1)
    res = client.put(
        "/api/fsrs/settings", json={"learning_steps": [30], "relearning_steps": [30]}
    )
    assert res.status_code == 200, res.text
    status = client.get("/api/fsrs").json()
    assert status["learning_steps"] == [30]
    assert status["relearning_steps"] == [30]
    # Again on a learning card repeats the first step: ~30 minutes out.
    res = client.post(f"/api/review/{ids[0]}", json={"rating": 1})
    assert res.status_code == 200, res.text
    due = datetime.fromisoformat(res.json()["due"])
    if due.tzinfo is None:
        due = due.replace(tzinfo=UTC)
    delta = (due - datetime.now(UTC)).total_seconds() / 60
    assert 25 <= delta <= 35


def test_scheduler_steps_validation(client):
    register(client)
    assert client.put("/api/fsrs/settings", json={}).status_code == 400
    assert client.put("/api/fsrs/settings", json={"learning_steps": []}).status_code == 400
    assert client.put("/api/fsrs/settings", json={"learning_steps": [0]}).status_code == 400
    assert client.put("/api/fsrs/settings", json={"learning_steps": [2000]}).status_code == 400
    assert client.put("/api/fsrs/settings", json={"learning_steps": [1.5]}).status_code in (400, 422)


def test_workload_uses_per_deck_limits(client):
    user = register(client)
    deck, _ = make_deck(client, user, "W")
    assert client.get("/api/stats").json()["workload"][0]["new"] == fsrs_service.NEW_CARDS_PER_DAY
    client.put(f"/api/decks/{deck.id}", json={"new_cards_per_day": 7})
    assert client.get("/api/stats").json()["workload"][0]["new"] == 7
