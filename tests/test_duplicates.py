"""Duplicate warning: exact + embedding-similar matches for a new card."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole import embeddings
from smarthole.models import Card, Deck, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_duplicates_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


DECK_NAME = "Dup Deck"


def register(client, email="dup@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text


def make_card(client, deck_id, front, back):
    res = client.post(
        "/api/cards",
        json={"deck_id": deck_id, "front": front, "back": back},
    )
    assert res.status_code == 201, res.text
    return res.json()["card_id"]


def test_duplicates_finds_exact_match(client):
    register(client)
    user = User.objects(email="dup@example.com").first()
    deck = Deck(owner=user, name=DECK_NAME).save()
    make_card(client, str(deck.id), "Mitochondria", "Powerhouse")
    res = client.get(f"/api/decks/{deck.id}/duplicates?front=mito&back=")
    assert res.status_code == 200, res.text
    dups = res.json()["duplicates"]
    assert len(dups) == 1
    assert dups[0]["kind"] == "exact"
    assert dups[0]["front_text"] == "Mitochondria"


def test_duplicates_empty_when_nothing_matches(client):
    register(client)
    user = User.objects(email="dup@example.com").first()
    deck = Deck(owner=user, name=DECK_NAME).save()
    make_card(client, str(deck.id), "Mitochondria", "Powerhouse")
    # No key in this env, so the similarity half degrades to exact-only.
    res = client.get(f"/api/decks/{deck.id}/duplicates?front=zzzqqq&back=yyy")
    assert res.status_code == 200, res.text
    assert res.json() == {"duplicates": []}


def test_duplicates_includes_similar_hits(client, monkeypatch):
    register(client)
    user = User.objects(email="dup@example.com").first()
    deck = Deck(owner=user, name=DECK_NAME).save()
    card_id = make_card(client, str(deck.id), "Cellular respiration", "Makes ATP")
    card = Card.objects(id=card_id).first()

    monkeypatch.setattr(
        embeddings, "embed_text", lambda *a, **k: ([0.1] * 8, "fake-model")
    )

    def fake_similar(collection, vector, **kwargs):
        assert kwargs.get("deck_ids") == [deck.id]
        return [{"_id": card.id, "front_html": "Other front", "score": 0.85}]

    monkeypatch.setattr(embeddings, "similar_cards", fake_similar)
    res = client.get(f"/api/decks/{deck.id}/duplicates?front=zzz&back=yyy")
    assert res.status_code == 200, res.text
    dups = res.json()["duplicates"]
    assert len(dups) == 1
    assert dups[0]["kind"] == "similar"
    assert dups[0]["score"] == 0.85


def test_duplicates_validates_input(client):
    register(client)
    user = User.objects(email="dup@example.com").first()
    deck = Deck(owner=user, name=DECK_NAME).save()
    assert (
        client.get(f"/api/decks/{deck.id}/duplicates?front=&back=").status_code
        == 400
    )
    assert (
        client.get("/api/decks/000000000000000000000000/duplicates?front=x").status_code
        == 404
    )
