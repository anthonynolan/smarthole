"""Deck chat: retrieve cards by similarity, answer tutor-style."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import ai_review, embeddings
from smarthole import app as app_module
from smarthole.models import Card, Deck, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_chat_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="chat-user@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text


def make_deck_with_cards(client, email, name, fronts):
    user = User.objects(email=email).first()
    deck = Deck(owner=user, name=name).save()
    ids = []
    for front in fronts:
        res = client.post(
            "/api/cards",
            json={"deck_id": str(deck.id), "front": front, "back": f"{front} back"},
        )
        assert res.status_code == 201, res.text
        ids.append(res.json()["card_id"])
    return deck, ids


def stub_retrieval(monkeypatch, seen):
    def fake_embed(text, **kwargs):
        return [0.1] * 8, "fake-model"

    def fake_similar(
        collection, vector, *, exclude_id=None, deck_ids=None, limit=8,
        min_score=0.0, **kwargs,
    ):
        seen["deck_ids"] = deck_ids
        cards = Card.objects(deck__in=deck_ids) if deck_ids else Card.objects
        return [
            {
                "_id": c.id,
                "front_html": c.front_html,
                "deck": c.deck.id,
                "score": 0.9,
            }
            for c in cards[:limit]
        ]

    monkeypatch.setattr(embeddings, "embed_text", fake_embed)
    monkeypatch.setattr(embeddings, "similar_cards", fake_similar)


def test_chat_answers_with_cited_cards(client, monkeypatch):
    register(client)
    deck, _ = make_deck_with_cards(client, "chat-user@example.com", "Bio", ["Mitochondria"])
    seen = {}
    stub_retrieval(monkeypatch, seen)

    answered = {}

    def fake_answer(question, cards, history=None, client=None):
        answered["question"] = question
        answered["cards"] = cards
        answered["history"] = history
        return "The powerhouse of the cell.", "test-model"

    monkeypatch.setattr(ai_review, "answer_chat_with_ai", fake_answer)
    res = client.post(
        "/api/chat",
        json={
            "message": "what makes energy?",
            "history": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["answer"] == "The powerhouse of the cell."
    assert body["model"] == "test-model"
    assert len(body["cards"]) == 1
    assert body["cards"][0]["front_text"] == "Mitochondria"
    assert body["cards"][0]["deck_name"] == "Bio"
    # The model got the card text as context plus the conversation.
    assert answered["question"] == "what makes energy?"
    assert answered["cards"][0]["front"] == "Mitochondria"
    assert answered["cards"][0]["back"] == "Mitochondria back"
    assert [m["role"] for m in answered["history"]] == ["user", "assistant"]
    assert seen["deck_ids"] == [deck.id]


def test_chat_scopes_to_requested_decks(client, monkeypatch):
    register(client)
    deck_a, _ = make_deck_with_cards(client, "chat-user@example.com", "A", ["Alpha"])
    make_deck_with_cards(client, "chat-user@example.com", "B", ["Beta"])
    seen = {}
    stub_retrieval(monkeypatch, seen)
    monkeypatch.setattr(
        ai_review, "answer_chat_with_ai", lambda q, c, h=None, client=None: ("ok", "m")
    )
    res = client.post(
        "/api/chat", json={"message": "q?", "deck_ids": [str(deck_a.id)]}
    )
    assert res.status_code == 200, res.text
    assert seen["deck_ids"] == [deck_a.id]
    assert res.json()["cards"][0]["front_text"] == "Alpha"


def test_chat_validates_input_and_decks(client, monkeypatch):
    register(client)
    assert client.post("/api/chat", json={"message": "  "}).status_code == 400
    assert (
        client.post(
            "/api/chat",
            json={"message": "q?", "deck_ids": ["000000000000000000000000"]},
        ).status_code
        == 404
    )


def test_chat_degrades_without_embeddings(client, monkeypatch):
    register(client)
    monkeypatch.setattr(
        embeddings,
        "embed_text",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no key")),
    )
    res = client.post("/api/chat", json={"message": "q?"})
    assert res.status_code == 503, res.text


def test_build_chat_prompt_caps_history():
    history = [{"role": "user", "text": f"m{i}"} for i in range(30)]
    prompt = ai_review.build_chat_prompt(
        "final?",
        [{"front": "Q", "back": "A", "deck_name": "D"}],
        history,
    )
    assert "Card 1 (D)" in prompt
    assert "Q" in prompt and "final?" in prompt
    assert "m0" not in prompt  # capped to the last 10
    assert "m29" in prompt
