"""Embeddings + related-card search (Atlas vector index method, grimoire-style)."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

import smarthole.app as app_module
import smarthole.embeddings as embeddings_module
from smarthole.models import Card


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_embed_test",
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


class _FakeEmbeddings:
    def __init__(self, dims=4):
        self.dims = dims
        self.calls = []

    def create(self, input, model):
        texts = input if isinstance(input, list) else [input]
        self.calls.append((texts, model))

        class _D:
            def __init__(self, emb):
                self.embedding = emb

        class _Resp:
            pass

        resp = _Resp()
        resp.data = [_D([0.1 * (i + 1)] * self.dims) for i in range(len(texts))]
        return resp


class _FakeClient:
    def __init__(self, fake):
        self.embeddings = fake


def test_card_embedding_text_strips_html():
    text = embeddings_module.card_embedding_text("<p>Hello<br>world</p>", "<b>Bye</b>")
    assert text == "Hello\nworld\n\nBye"


def test_embed_text_uses_default_model_and_key(monkeypatch):
    fake = _FakeEmbeddings()
    monkeypatch.setattr(
        embeddings_module, "_get_client", lambda: _FakeClient(fake)
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    vec, model = embeddings_module.embed_text("hello")
    assert len(vec) == 4
    assert model == "text-embedding-3-small"
    assert fake.calls[0][1] == "text-embedding-3-small"


def test_embed_requires_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        embeddings_module.embed_text("hello")


def test_refresh_card_embedding_best_effort(client, monkeypatch):
    register(client)
    deck = _own_deck(client)
    card = Card(deck=deck, front_html="Q", back_html="A").save()

    # No key: leaves the card alone, never raises.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert embeddings_module.refresh_card_embedding(card) is False
    card.reload()
    assert card.embedding == []

    fake = _FakeEmbeddings()
    monkeypatch.setattr(embeddings_module, "_get_client", lambda: _FakeClient(fake))
    assert embeddings_module.refresh_card_embedding(card) is True
    card.reload()
    assert len(card.embedding) == 4
    assert card.embedding_model == "text-embedding-3-small"


def test_create_card_embeds_best_effort(client, monkeypatch):
    register(client)
    deck = _own_deck(client)
    fake = _FakeEmbeddings()
    monkeypatch.setattr(embeddings_module, "_get_client", lambda: _FakeClient(fake))
    res = client.post(
        "/api/cards",
        json={"deck_id": str(deck.id), "front": "Q?", "back": "A!"},
    )
    assert res.status_code == 201, res.text
    card = Card.objects(id=res.json()["card_id"]).first()
    assert len(card.embedding) == 4
    # Embedding input is the plain-text card, not raw HTML.
    assert fake.calls[0][0] == ["Q?\n\nA!"]


def test_similar_cards_pipeline_and_min_score():
    seen = {}

    class _Coll:
        def aggregate(self, pipeline):
            seen["pipeline"] = pipeline
            return [
                {"_id": "a", "front_html": "Hi", "deck": "d", "score": 0.9},
                {"_id": "b", "front_html": "Lo", "deck": "d", "score": 0.2},
            ]

    rows = embeddings_module.similar_cards(
        _Coll(),
        [0.1, 0.2],
        exclude_id="self",
        deck_ids=["d"],
        limit=3,
        min_score=0.7,
        index="card_embedding_index",
    )
    assert [r["_id"] for r in rows] == ["a"]
    search = seen["pipeline"][0]["$vectorSearch"]
    assert search["index"] == "card_embedding_index"
    assert search["path"] == "embedding"
    assert search["queryVector"] == [0.1, 0.2]
    match = seen["pipeline"][1]["$match"]
    assert match["deleted"] == {"$ne": True}
    assert match["suspended"] is False
    assert match["_id"] == {"$ne": "self"}
    assert match["deck"] == {"$in": ["d"]}


def _make_card(client):
    deck = _own_deck(client)
    res = client.post(
        "/api/cards", json={"deck_id": str(deck.id), "front": "Q", "back": "A"}
    )
    assert res.status_code == 201, res.text
    return res.json()["card_id"]


def test_related_endpoint_shapes_rows(client, monkeypatch):
    register(client)
    card_id = _make_card(client)

    def fake_find(user, card, limit=3):
        assert str(card.id) == card_id
        return [
            {
                "card_id": "other",
                "front_text": "Other Q",
                "deck_name": "D",
                "score": 0.88,
            }
        ]

    monkeypatch.setattr(app_module, "find_related_cards", fake_find)
    res = client.get(f"/api/cards/{card_id}/related")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["unavailable"] is False
    assert body["cards"][0]["front_text"] == "Other Q"


def test_related_endpoint_unavailable_when_no_index(client, monkeypatch):
    register(client)
    card_id = _make_card(client)

    def boom(user, card, limit=3):
        raise RuntimeError("no vector index")

    monkeypatch.setattr(app_module, "find_related_cards", boom)
    res = client.get(f"/api/cards/{card_id}/related")
    assert res.status_code == 200, res.text
    assert res.json() == {"cards": [], "unavailable": True}


def test_get_card_detail_and_404s(client):
    from smarthole.models import Deck, User

    register(client)
    card_id = _make_card(client)
    res = client.get(f"/api/cards/{card_id}")
    assert res.status_code == 200, res.text
    assert res.json()["card_id"] == card_id
    assert "meta" in res.json()

    other = User(email="other@example.com", pw_hash="x").save()
    theirs = Deck(owner=other, name="Theirs").save()
    res = client.post(
        "/api/cards", json={"deck_id": str(theirs.id), "front": "Q", "back": "A"}
    )
    assert res.status_code == 404  # another owner's deck rejects create

    assert client.get("/api/cards/000000000000000000000000").status_code == 404
