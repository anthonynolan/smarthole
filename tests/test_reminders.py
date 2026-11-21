"""Streaks, daily goals, preferences, and email reminders."""

import os
from datetime import UTC, datetime, timedelta

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from smarthole import reminders
from smarthole.models import Card, Deck, Review, User


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_reminders_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email="streak@example.com"):
    res = client.post(
        "/api/register", json={"email": email, "password": "secret123"}
    )
    assert res.status_code == 201, res.text
    return User.objects(email=email).first()


def add_review(user, card, days_ago, hour=12):
    when = datetime.now(UTC).replace(
        hour=hour, minute=0, second=0, microsecond=0
    ) - timedelta(days=days_ago)
    Review(user=user, card=card, rating=3, reviewed_at=when, next_due=when).save()


def test_compute_streak_cases():
    from datetime import date

    today = date(2026, 11, 21)
    assert reminders.compute_streak(set(), today) == 0
    assert reminders.compute_streak({today}, today) == 1
    days = {today - timedelta(days=i) for i in range(5)}
    assert reminders.compute_streak(days, today) == 5
    # Today unstudied but yesterday studied: streak is alive.
    assert reminders.compute_streak({today - timedelta(days=1)}, today) == 1
    # A gap splits the run: only the recent run counts.
    assert (
        reminders.compute_streak(
            {today, today - timedelta(days=1), today - timedelta(days=5)}, today
        )
        == 2
    )
    # Nothing since last week: streak is 0, not stale.
    assert reminders.compute_streak({today - timedelta(days=9)}, today) == 0


def test_preferences_roundtrip_and_validation(client):
    register(client)
    assert client.get("/api/preferences").json() == {
        "daily_goal": 20,
        "reminder_enabled": False,
    }
    res = client.put(
        "/api/preferences", json={"daily_goal": 30, "reminder_enabled": True}
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"daily_goal": 30, "reminder_enabled": True}
    # Partial update keeps the rest.
    res = client.put("/api/preferences", json={"daily_goal": 10})
    assert res.json() == {"daily_goal": 10, "reminder_enabled": True}
    assert client.put("/api/preferences", json={"daily_goal": 0}).status_code == 400
    assert (
        client.put("/api/preferences", json={"daily_goal": 1001}).status_code == 400
    )


def test_stats_reports_streak_and_goal(client):
    user = register(client)
    deck = Deck(owner=user, name="S").save()
    card = Card(deck=deck, front_html="Q", back_html="A").save()
    add_review(user, card, days_ago=0)
    add_review(user, card, days_ago=1)
    body = client.get("/api/stats").json()
    assert body["streak"] == 2
    assert body["goal"] == {"target": 20, "studied": 1, "met": False}


def test_users_needing_reminder(client):
    now = datetime.now(UTC)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    studied = register(client, "studied@example.com")
    idle = register(client, "idle@example.com")
    register(client, "quiet@example.com")
    User.objects(email="idle@example.com").update_one(set__reminder_enabled=True)
    User.objects(email="studied@example.com").update_one(set__reminder_enabled=True)
    idle.reload()
    studied.reload()
    deck = Deck(owner=idle, name="D").save()
    card = Card(deck=deck, front_html="Q", back_html="A").save()
    studied_card = Card(deck=Deck(owner=studied, name="D2").save(),
                        front_html="Q", back_html="A").save()
    add_review(idle, card, days_ago=1)
    add_review(studied, studied_card, days_ago=0)
    got = {e["user"].email: e for e in reminders.users_needing_reminder(now, today_start)}
    assert set(got) == {"idle@example.com"}
    assert got["idle@example.com"]["streak"] == 1


def test_send_email_uses_smtp(monkeypatch):
    sent = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            sent["host"] = host
            sent["port"] = port

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def starttls(self):
            sent["tls"] = True

        def login(self, user, password):
            sent["login"] = (user, password)

        def send_message(self, msg):
            sent["msg"] = msg

    monkeypatch.setattr(reminders.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setenv("SMTP_HOST", "mail.example.com")
    monkeypatch.setenv("SMTP_PORT", "2525")
    monkeypatch.setenv("SMTP_USER", "u")
    monkeypatch.setenv("SMTP_PASS", "p")
    monkeypatch.setenv("SMTP_FROM", "smarthole@example.com")
    reminders.send_email(reminders.build_reminder_email("a@b.c", 4, 7))
    assert sent["host"] == "mail.example.com"
    assert sent["port"] == 2525
    assert sent["tls"] is True
    assert sent["login"] == ("u", "p")
    assert "4-day streak" in sent["msg"]["Subject"]
    assert "a@b.c" in sent["msg"]["To"]
    assert "smarthole@example.com" in sent["msg"]["From"]


def test_send_email_requires_host(monkeypatch):
    monkeypatch.delenv("SMTP_HOST", raising=False)
    with pytest.raises(RuntimeError, match="SMTP_HOST"):
        reminders.send_email(reminders.build_reminder_email("a@b.c", 0, 0))
