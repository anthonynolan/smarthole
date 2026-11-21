"""AI-generated cards from pasted content: propose, verify, create."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import ai_review
from smarthole import app as app_module
from smarthole.models import Card, Deck, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_generate_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="gen-user@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    user = User.objects(email=email).first()
    return str(Deck(owner=user, name="Gen Deck").save().id)


def test_generate_proposes_without_writing(client, monkeypatch):
    deck_id = register(client)
    monkeypatch.setattr(
        ai_review,
        "propose_cards_from_text",
        lambda content, client=None: (
            [{"front": "Q1", "back": "A1"}, {"front": "Q2", "back": "A2"}],
            "test-model",
        ),
    )
    res = client.post(
        "/api/cards/generate",
        json={"deck_id": deck_id, "content": "Mitochondria makes energy."},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {
        "suggestions": [
            {"front": "Q1", "back": "A1"},
            {"front": "Q2", "back": "A2"},
        ],
        "model": "test-model",
    }
    # Proposal alone writes nothing.
    assert Card.objects.count() == 0


def test_generate_validates_input(client):
    deck_id = register(client)
    assert (
        client.post(
            "/api/cards/generate", json={"deck_id": deck_id, "content": "  "}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/cards/generate",
            json={"deck_id": deck_id, "content": "x" * 9000},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/cards/generate",
            json={"deck_id": "000000000000000000000000", "content": "x"},
        ).status_code
        == 404
    )
    client.post("/api/logout", json={})
    assert (
        client.post(
            "/api/cards/generate", json={"deck_id": deck_id, "content": "x"}
        ).status_code
        == 401
    )


def test_generate_missing_key_is_503(client, monkeypatch):
    deck_id = register(client)
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.setattr(
        app_module.ai_review,
        "propose_cards_from_text",
        ai_review.propose_cards_from_text,
    )
    res = client.post(
        "/api/cards/generate", json={"deck_id": deck_id, "content": "x"}
    )
    assert res.status_code == 503, res.text
