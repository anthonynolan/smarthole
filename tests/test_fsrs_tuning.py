"""FSRS tuning: status, optimize on review history, reschedule, reset."""

import os

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
        "smarthole_fsrs_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="fsrs@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    return User.objects(email=email).first()


def grade_many(client, card_ids, ratings):
    for card_id in card_ids:
        for rating in ratings:
            res = client.post(f"/api/review/{card_id}", json={"rating": rating})
            assert res.status_code == 200, res.text


def test_fsrs_status_defaults(client):
    register(client)
    body = client.get("/api/fsrs").json()
    assert body["custom"] is False
    assert len(body["parameters"]) == 21
    assert body["parameters"] == body["default_parameters"]
    assert body["review_count"] == 0


def test_fsrs_optimize_needs_history(client):
    register(client)
    res = client.post("/api/fsrs/optimize")
    assert res.status_code == 400, res.text
    assert "at least" in res.text


def test_fsrs_optimize_reschedule_reset_roundtrip(client):
    user = register(client)
    deck = Deck(owner=user, name="Tune").save()
    card_ids = []
    for n in range(3):
        card = Card(deck=deck, front_html=f"Q{n}", back_html="A").save()
        CardState(
            user=user, card=card, new_position=n + 1, **fsrs_service.fresh_state()
        ).save()
        card_ids.append(str(card.id))
    grade_many(client, card_ids, [3] * 14 + [4] * 3 + [2] * 2 + [1])

    res = client.post("/api/fsrs/optimize")
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["parameters"]) == 21
    assert body["log_loss_after"] <= body["log_loss_before"] + 1e-9
    assert body["reviews_used"] >= fsrs_service.MIN_TUNE_REVIEWS
    from fsrs.scheduler import LOWER_BOUNDS_PARAMETERS, UPPER_BOUNDS_PARAMETERS

    for value, low, high in zip(
        body["parameters"],
        LOWER_BOUNDS_PARAMETERS,
        UPPER_BOUNDS_PARAMETERS,
        strict=True,
    ):
        assert low <= value <= high

    status = client.get("/api/fsrs").json()
    assert status["custom"] is True
    assert status["reviews_used"] == body["reviews_used"]

    # Reviewing still works on tuned weights.
    assert client.post(f"/api/review/{card_ids[0]}", json={"rating": 3}).status_code == 200

    res = client.post("/api/fsrs/reschedule")
    assert res.status_code == 200, res.text
    assert res.json() == {"rescheduled": 3}
    for state in CardState.objects(user=user):
        assert state.due is not None
        assert state.stability is not None

    assert client.post("/api/fsrs/reset").json() == {"reset": True}
    assert client.get("/api/fsrs").json()["custom"] is False


def test_fsrs_tuning_is_per_user(client):
    user_a = register(client, "a@example.com")
    register(client, "b@example.com")
    deck = Deck(owner=user_a, name="Tune").save()
    card_ids = []
    for n in range(3):
        card = Card(deck=deck, front_html=f"Q{n}", back_html="A").save()
        CardState(
            user=user_a, card=card, new_position=n + 1, **fsrs_service.fresh_state()
        ).save()
        card_ids.append(str(card.id))
    client.post("/api/login", json={"email": "a@example.com", "password": "secret123"})
    grade_many(client, card_ids, [3] * 20)
    assert client.post("/api/fsrs/optimize").status_code == 200
    client.post("/api/login", json={"email": "b@example.com", "password": "secret123"})
    assert client.get("/api/fsrs").json()["custom"] is False
