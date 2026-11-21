"""Tags: set per card, bulk add/remove, filter browse by tag."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole.models import Card, Deck, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_tags_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="tags@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    return User.objects(email=email).first()


def make_card(client, deck, front):
    res = client.post(
        "/api/cards",
        json={"deck_id": str(deck.id), "front": front, "back": "B"},
    )
    assert res.status_code == 201, res.text
    return res.json()["card_id"]


def test_set_card_tags_normalizes(client):
    user = register(client)
    deck = Deck(owner=user, name="T").save()
    card_id = make_card(client, deck, "Q")
    res = client.patch(
        f"/api/cards/{card_id}/tags", json={"tags": ["Biology", "  Cell ", "biology", ""]}
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"card_id": card_id, "tags": ["biology", "cell"]}
    row = client.get(f"/api/decks/{deck.id}/cards").json()["cards"][0]
    assert row["tags"] == ["biology", "cell"]
    assert client.get(f"/api/cards/{card_id}").json()["tags"] == ["biology", "cell"]


def test_set_card_tags_validates(client):
    user = register(client)
    deck = Deck(owner=user, name="T").save()
    card_id = make_card(client, deck, "Q")
    assert client.patch(
        f"/api/cards/{card_id}/tags", json={"tags": [f"t{i}" for i in range(21)]}
    ).status_code == 400
    assert client.patch(
        f"/api/cards/{card_id}/tags", json={"tags": ["x" * 51]}
    ).status_code == 400
    assert client.patch(
        "/api/cards/000000000000000000000000/tags", json={"tags": ["a"]}
    ).status_code == 404
    register(client, "other@example.com")
    assert client.patch(
        f"/api/cards/{card_id}/tags", json={"tags": ["a"]}
    ).status_code == 404


def test_bulk_tags_add_and_remove(client):
    user = register(client)
    deck = Deck(owner=user, name="T").save()
    first = make_card(client, deck, "Q1")
    second = make_card(client, deck, "Q2")
    client.patch(f"/api/cards/{first}/tags", json={"tags": ["old"]})
    res = client.post(
        "/api/cards/bulk-tags",
        json={
            "card_ids": [first, second, "000000000000000000000000"],
            "add": ["New"],
            "remove": ["old", "missing"],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2}
    assert Card.objects(id=first).first().tags == ["new"]
    assert Card.objects(id=second).first().tags == ["new"]
    assert client.post(
        "/api/cards/bulk-tags", json={"card_ids": [], "add": ["x"]}
    ).status_code == 400


def test_browse_filters_by_tag(client):
    user = register(client)
    deck = Deck(owner=user, name="T").save()
    tagged = make_card(client, deck, "Tagged Q")
    make_card(client, deck, "Plain Q")
    client.patch(f"/api/cards/{tagged}/tags", json={"tags": ["Biology"]})
    body = client.get(f"/api/decks/{deck.id}/cards?tag=biology").json()
    assert [c["front_text"] for c in body["cards"]] == ["Tagged Q"]
    assert client.get(f"/api/decks/{deck.id}/cards?tag=nope").json()["cards"] == []
