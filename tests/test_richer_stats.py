"""Richer stats: true-retention buckets and forecast workload."""

import os
from datetime import UTC, datetime, timedelta

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole import fsrs_service
from smarthole.models import Card, Deck, Review, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_richer_stats_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def test_stats_reports_retention_and_workload(client):
    res = client.post(
        "/api/register", json={"email": "rich@example.com", "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    user = User.objects(email="rich@example.com").first()
    deck = Deck(owner=user, name="R").save()
    card = Card(deck=deck, front_html="Q", back_html="A").save()

    now = datetime.now(UTC)
    reviews = [
        # Learning: sub-day interval, recalled.
        (now, now + timedelta(minutes=10), 3),
        # Young: 5-day interval, one recalled, one forgotten.
        (now - timedelta(days=5), now, 2),
        (now - timedelta(days=6), now - timedelta(days=1), 1),
        # Mature: 30-day interval, recalled.
        (now - timedelta(days=40), now - timedelta(days=10), 3),
    ]
    for reviewed_at, next_due, rating in reviews:
        Review(
            user=user, card=card, rating=rating,
            reviewed_at=reviewed_at, next_due=next_due,
        ).save()

    body = client.get("/api/stats").json()
    retention = {r["bucket"]: r for r in body["retention"]}
    assert retention["learning"] == {
        "bucket": "learning", "reviews": 1, "correct": 1, "rate": 100.0,
    }
    assert retention["young"] == {
        "bucket": "young", "reviews": 2, "correct": 1, "rate": 50.0,
    }
    assert retention["mature"] == {
        "bucket": "mature", "reviews": 1, "correct": 1, "rate": 100.0,
    }
    workload = body["workload"]
    assert len(workload) == 30
    assert workload[0]["date"] == now.date().isoformat()
    assert all(w["new"] == fsrs_service.NEW_CARDS_PER_DAY for w in workload)
    assert all(set(w) == {"date", "due", "new"} for w in workload)
