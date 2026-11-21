"""Review heatmap: per-day review counts over the last year in /api/stats."""

import os
from datetime import UTC, datetime, timedelta

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole.models import Card, Deck, Review, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_heatmap_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def test_stats_reports_review_history(client):
    res = client.post(
        "/api/register", json={"email": "heat@example.com", "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    user = User.objects(email="heat@example.com").first()
    deck = Deck(owner=user, name="Heat").save()
    card = Card(deck=deck, front_html="Q", back_html="A").save()

    now = datetime.now(UTC)
    for days_ago, count in ((0, 2), (1, 1), (400, 9)):
        for _ in range(count):
            Review(
                user=user,
                card=card,
                rating=3,
                reviewed_at=now - timedelta(days=days_ago),
                next_due=now,
            ).save()

    history = {
        h["date"]: h["reviews"] for h in client.get("/api/stats").json()["review_history"]
    }
    assert history[now.date().isoformat()] == 2
    assert history[(now - timedelta(days=1)).date().isoformat()] == 1
    # Outside the one-year window.
    assert (now - timedelta(days=400)).date().isoformat() not in history
