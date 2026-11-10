"""AI review endpoints: suggest single-fact cards, keep selection, delete original."""

import json
import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import ai_review
from smarthole import app as app_module
from smarthole.models import Card, CardState


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_ai_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="ai-user@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text


def make_card(client):
    decks = client.get("/api/decks").json()["decks"]
    if not decks:
        # Create a deck via direct model to avoid an extra endpoint.
        from smarthole.models import Deck, User

        user = User.objects(email="ai-user@example.com").first()
        deck_id = str(Deck(owner=user, name="AI Deck").save().id)
    else:
        deck_id = decks[0]["id"]
    res = client.post(
        "/api/cards",
        json={"deck_id": deck_id, "front": "Q front", "back": "A back"},
    )
    assert res.status_code == 201, res.text
    return res.json()["card_id"], deck_id


def test_parse_suggestions_shapes():
    out = ai_review.parse_suggestions('{"cards": [{"front": "Q", "back": "A"}]}')
    assert out == [{"front": "Q", "back": "A"}]

    fenced = ai_review.parse_suggestions(
        '```json\n{"cards": [{"front": "Q1", "back": "A1"},'
        ' {"front": "", "back": "x"}]}\n```'
    )
    assert fenced == [{"front": "Q1", "back": "A1"}]

    as_list = ai_review.parse_suggestions('[{"front": "Q", "back": "A"}]')
    assert as_list == [{"front": "Q", "back": "A"}]

    # Explicit empty list means the AI concluded no change is needed.
    assert ai_review.parse_suggestions('{"cards": []}') == []
    assert ai_review.parse_suggestions("[]") == []

    with pytest.raises(ValueError):
        ai_review.parse_suggestions('{"nope": []}')
    with pytest.raises(ValueError):
        ai_review.parse_suggestions('{"cards": [{"front": "", "back": ""}]}')
    with pytest.raises(json.JSONDecodeError):
        ai_review.parse_suggestions("not json")


def test_build_prompt_strips_html():
    prompt = ai_review.build_prompt("<p>What is <b>Paris</b>?</p>", "Capital")
    assert "What is Paris?" in prompt
    assert "Capital" in prompt
    assert "<p>" not in prompt


def test_review_endpoint_returns_stubbed_suggestions(client, monkeypatch):
    register(client)
    card_id, _ = make_card(client)

    def fake(front_html, back_html):
        assert "Q front" in front_html
        return [{"front": "Q1", "back": "A1"}], "muse-spark-1.3-contributor"

    monkeypatch.setattr(ai_review, "review_card_with_ai", fake)
    res = client.post(f"/api/cards/{card_id}/ai-review", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["suggestions"] == [{"front": "Q1", "back": "A1"}]
    assert body["model"] == "muse-spark-1.3-contributor"


def test_review_endpoint_passes_through_no_change(client, monkeypatch):
    register(client)
    card_id, _ = make_card(client)
    monkeypatch.setattr(
        ai_review, "review_card_with_ai", lambda f, b: ([], "muse-spark-1.3-contributor")
    )
    res = client.post(f"/api/cards/{card_id}/ai-review", json={})
    assert res.status_code == 200, res.text
    assert res.json() == {"suggestions": [], "model": "muse-spark-1.3-contributor"}


def test_review_endpoint_missing_key_is_503(client, monkeypatch):
    register(client)
    card_id, _ = make_card(client)
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    # Force the real implementation (un-stubbed) to run.
    monkeypatch.setattr(
        app_module.ai_review,
        "review_card_with_ai",
        ai_review.review_card_with_ai.__wrapped__
        if hasattr(ai_review.review_card_with_ai, "__wrapped__")
        else ai_review.review_card_with_ai,
    )
    res = client.post(f"/api/cards/{card_id}/ai-review", json={})
    assert res.status_code == 503
    assert "MODEL_API_KEY" in res.text


def test_review_requires_login_and_ownership(client, monkeypatch):
    register(client)
    card_id, _ = make_card(client)
    monkeypatch.setattr(
        ai_review, "review_card_with_ai", lambda f, b: ([{"front": "Q", "back": "A"}], "m")
    )
    # Logged out.
    client.post("/api/logout", json={})
    assert client.post(f"/api/cards/{card_id}/ai-review", json={}).status_code == 401
    assert client.delete(f"/api/cards/{card_id}").status_code == 401

    # Other user cannot touch it.
    register(client, email="other@example.com")
    assert client.post(f"/api/cards/{card_id}/ai-review", json={}).status_code == 404
    assert client.delete(f"/api/cards/{card_id}").status_code == 404


def test_update_card_edits_content(client):
    register(client)
    card_id, _ = make_card(client)
    res = client.put(
        f"/api/cards/{card_id}", json={"front": "New Q", "back": "New A"}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert "New Q" in body["front_html"] and "New A" in body["back_html"]

    nxt = client.get("/api/next").json()["cards"]
    assert len(nxt) == 1
    assert "New Q" in nxt[0]["front_html"] and "New A" in nxt[0]["back_html"]

    bad = client.put(f"/api/cards/{card_id}", json={"front": "  ", "back": "x"})
    assert bad.status_code == 400


def test_update_card_requires_login_and_ownership(client):
    register(client)
    card_id, _ = make_card(client)
    client.post("/api/logout", json={})
    assert (
        client.put(f"/api/cards/{card_id}", json={"front": "Q", "back": "A"}).status_code
        == 401
    )
    register(client, email="other@example.com")
    assert (
        client.put(f"/api/cards/{card_id}", json={"front": "Q", "back": "A"}).status_code
        == 404
    )


def test_next_includes_card_created_at(client):
    register(client)
    card_id, _ = make_card(client)
    card = Card.objects(id=card_id).first()
    assert card.created_at is not None
    nxt = client.get("/api/next").json()["cards"]
    assert len(nxt) == 1
    assert nxt[0]["created_at"] == card.created_at.isoformat()


def test_ai_review_custom_question_returns_answer(client, monkeypatch):
    register(client)
    card_id, _ = make_card(client)

    def fake(front_html, back_html, question):
        assert "Q front" in front_html
        assert question == "is this card still valid?"
        return "Yes — it still tests one fact clearly.", "muse-spark-1.3-contributor"

    monkeypatch.setattr(ai_review, "answer_question_with_ai", fake)
    res = client.post(
        f"/api/cards/{card_id}/ai-review",
        json={"mode": "custom", "question": "is this card still valid?"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["answer"] == "Yes — it still tests one fact clearly."
    assert body["model"] == "muse-spark-1.3-contributor"


def test_ai_review_custom_requires_question(client):
    register(client)
    card_id, _ = make_card(client)
    res = client.post(
        f"/api/cards/{card_id}/ai-review", json={"mode": "custom", "question": "  "}
    )
    assert res.status_code == 400


def test_ai_review_stream_split_streams_deltas(client, monkeypatch):
    import json as json_module

    register(client)
    card_id, _ = make_card(client)

    def fake_stream(front_html, back_html, mode="split", question=None, client=None):
        assert mode == "split"
        yield '{"cards": [{"front": "Q1",'
        yield '"back": "A1"}]}'

    monkeypatch.setattr(ai_review, "stream_review_with_ai", fake_stream)
    with client.stream(
        "GET", f"/api/cards/{card_id}/ai-review/stream?mode=split"
    ) as res:
        assert res.status_code == 200, res.text
        raw = res.read().decode("utf-8")
        lines = [
            json_module.loads(line)
            for line in raw.strip().splitlines()
            if line.strip()
        ]
    deltas = [ln["delta"] for ln in lines if "delta" in ln]
    assert "".join(deltas) == '{"cards": [{"front": "Q1","back": "A1"}]}'
    final = next(ln for ln in lines if ln.get("done"))
    assert final["suggestions"] == [{"front": "Q1", "back": "A1"}]
    assert final["model"] == "muse-spark-1.3-contributor"


def test_ai_review_stream_custom_returns_answer(client, monkeypatch):
    import json as json_module

    register(client)
    card_id, _ = make_card(client)

    def fake_stream(front_html, back_html, mode="split", question=None, client=None):
        assert mode == "custom"
        assert question == "is this card still valid?"
        yield "Yes, "
        yield "still valid."

    monkeypatch.setattr(ai_review, "stream_review_with_ai", fake_stream)
    with client.stream(
        "GET",
        f"/api/cards/{card_id}/ai-review/stream?mode=custom"
        "&question=is%20this%20card%20still%20valid%3F",
    ) as res:
        assert res.status_code == 200, res.text
        raw = res.read().decode("utf-8")
        lines = [
            json_module.loads(line)
            for line in raw.strip().splitlines()
            if line.strip()
        ]
    final = next(ln for ln in lines if ln.get("done"))
    assert final["answer"] == "Yes, still valid."


def test_delete_is_logical_by_default(client):
    from smarthole.models import Review

    register(client)
    card_id, _ = make_card(client)
    card = Card.objects(id=card_id).first()
    assert CardState.objects(card=card).count() == 1

    client.post(f"/api/review/{card_id}", json={"rating": 3})
    assert Review.objects(card=card).count() == 1

    # Plain DELETE only flags the card: schedule and reviews survive.
    res = client.delete(f"/api/cards/{card_id}")
    assert res.status_code == 200, res.text
    assert Card.objects(id=card_id).first() is not None
    assert CardState.objects(card=card).count() == 1
    assert Review.objects(card=card).count() == 1

    # Only permanent deletion purges the card, its state, and its reviews.
    res = client.delete(f"/api/cards/{card_id}?permanent=true")
    assert res.status_code == 200, res.text
    assert Card.objects(id=card_id).first() is None
    assert CardState.objects(card=card).count() == 0
    assert Review.objects(card=card).count() == 0
    assert client.delete(f"/api/cards/{card_id}").status_code == 404
