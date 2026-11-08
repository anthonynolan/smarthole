"""End-to-end: register -> import synthetic .apkg -> due queue -> grade -> due advances."""

import json
import os
import sqlite3
import zipfile

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module


@pytest.fixture()
def client(tmp_path):
    disconnect(alias="default")
    connect(
        "smarthole_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def make_apkg(path) -> None:
    db_path = str(path / "collection.anki2")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE col(id INTEGER PRIMARY KEY, crt INT, mod INT, scm INT, ver INT,"
        " dty INT, usn INT, ls INT, conf TEXT, models TEXT, decks TEXT, dconf TEXT, tags TEXT)"
    )
    models = {
        "1": {
            "flds": [{"name": "Front"}, {"name": "Back"}],
            "tmpls": [
                {"ord": 0, "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr>{{Back}}"}
            ],
            "type": 0,
        }
    }
    decks = {"1": {"name": "Test", "id": 1}}
    conn.execute(
        "INSERT INTO col VALUES (1,0,0,0,11,0,0,0,'{}',?,?, '{}','')",
        (json.dumps(models), json.dumps(decks)),
    )
    conn.execute(
        "CREATE TABLE notes(id INT PRIMARY KEY, guid TEXT, mid INT, mod INT, usn INT,"
        " tags TEXT, flds TEXT, sfld TEXT, csum INT, flags INT, data TEXT)"
    )
    conn.execute(
        "INSERT INTO notes VALUES (1,'guid-1',1,0,0,'','Q1\x1fA1','Q1',0,0,'')"
    )
    conn.execute(
        "INSERT INTO notes VALUES (2,'guid-2',1,0,0,'','Q2\x1fA2','Q2',0,0,'')"
    )
    conn.execute(
        "CREATE TABLE cards(id INT PRIMARY KEY, nid INT, did INT, ord INT, mod INT,"
        " usn INT, type INT, queue INT, due INT, ivl INT, factor INT, reps INT,"
        " lapses INT, left INT, odue INT, odid INT, flags INT, data TEXT)"
    )
    conn.execute("INSERT INTO cards VALUES (1,1,1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,'')")
    conn.execute("INSERT INTO cards VALUES (2,2,1,0,0,0,0,0,2,0,0,0,0,0,0,0,0,'')")
    conn.commit()
    conn.close()
    apkg = str(path / "test.apkg")
    with zipfile.ZipFile(apkg, "w") as zf:
        zf.write(db_path, "collection.anki2")
        zf.writestr("media", "{}")
    return apkg


def register(client):
    res = client.post(
        "/api/register",
        json={"email": "user@example.com", "password": "secret123"},
    )
    assert res.status_code == 201, res.text


def make_sched_apkg(path, now_ms):
    """Legacy export with scheduling: review + learning + new + suspended."""
    import time

    db_path = str(path / "collection.anki2")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE col(id INTEGER PRIMARY KEY, crt INT, mod INT, scm INT, ver INT,"
        " dty INT, usn INT, ls INT, conf TEXT, models TEXT, decks TEXT, dconf TEXT, tags TEXT)"
    )
    models = {
        "1": {
            "flds": [{"name": "Front"}, {"name": "Back"}],
            "tmpls": [
                {"ord": 0, "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr>{{Back}}"}
            ],
            "type": 0,
        }
    }
    decks = {"1": {"name": "Sched", "id": 1}}
    conn.execute(
        "INSERT INTO col VALUES (1,1700000000,0,0,11,0,0,0,'{}',?,?, '{}','')",
        (json.dumps(models), json.dumps(decks)),
    )
    conn.execute(
        "CREATE TABLE notes(id INT PRIMARY KEY, guid TEXT, mid INT, mod INT, usn INT,"
        " tags TEXT, flds TEXT, sfld TEXT, csum INT, flags INT, data TEXT)"
    )
    for nid, guid, q in (
        (10, "g10", "RQ"),
        (11, "g11", "LQ"),
        (12, "g12", "NQ"),
        (13, "g13", "SQ"),
    ):
        conn.execute(
            "INSERT INTO notes VALUES (?,?,1,0,0,'',?,?,0,0,'')",
            (nid, guid, f"{q}\x1f{q}A", q),
        )
    conn.execute(
        "CREATE TABLE cards(id INT PRIMARY KEY, nid INT, did INT, ord INT, mod INT,"
        " usn INT, type INT, queue INT, due INT, ivl INT, factor INT, reps INT,"
        " lapses INT, left INT, odue INT, odid INT, flags INT, data TEXT)"
    )
    learn_due = int(time.time()) + 3600
    # Day number placing this review card ~100 days after its last review.
    five_days_ago = now_ms - 5 * 86400 * 1000
    due_day = int(((five_days_ago / 1000 + 100 * 86400) - 1700000000) // 86400)
    conn.execute(
        "INSERT INTO cards VALUES (10,10,1,0,0,0, 2,2, ?, 100,2500, 10, 1,0,0,0,0,'')",
        (due_day,),
    )
    conn.execute(
        f"INSERT INTO cards VALUES (11,11,1,0,0,0, 1,1, {learn_due}, 0,0, 1, 0,0,0,0,0,'')"
    )
    conn.execute(
        "INSERT INTO cards VALUES (12,12,1,0,0,0, 0,0, 5, 0,0, 0, 0,0,0,0,0,'')"
    )
    conn.execute(
        "INSERT INTO cards VALUES (13,13,1,0,0,0, 2,-1, 20000, 50,2500, 5, 0,0,0,0,0,'')"
    )
    conn.execute(
        "CREATE TABLE revlog(id INT PRIMARY KEY, cid INT, usn INT, ease INT,"
        " ivl INT, lastIvl INT, factor INT, time INT, type INT)"
    )
    conn.execute(
        "INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)",
        (five_days_ago, 10, 0, 3, 100, 90, 2500, 5000, 1),
    )
    conn.commit()
    conn.close()
    apkg = str(path / "sched.apkg")
    with zipfile.ZipFile(apkg, "w") as zf:
        zf.write(db_path, "collection.anki2")
        zf.writestr("media", "{}")
    return apkg, learn_due, five_days_ago, due_day


def test_review_flow(client, tmp_path):
    assert client.get("/api/me").status_code == 401

    register(client)
    assert client.get("/api/me").status_code == 200

    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("test.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    assert res.json()["imported"] == 2

    decks = client.get("/api/decks").json()["decks"]
    assert len(decks) == 1
    assert decks[0]["due"] == 0  # new cards are not review-due
    assert decks[0]["new"] == 2

    due = client.get("/api/next").json()["cards"]
    assert len(due) == 1
    card_id = due[0]["card_id"]
    assert "Q1" in due[0]["front_html"] and "A1" in due[0]["back_html"]
    # The {{FrontSide}} echo in the answer template is stripped for review:
    # the question must not be repeated before the answer.
    assert "Q1" not in due[0]["back_html"]
    # Grade-button previews: one next-due per rating.
    assert set(due[0]["intervals"]) == {"1", "2", "3", "4"}

    graded = client.post(f"/api/review/{card_id}", json={"rating": 3}).json()
    assert graded["reps"] == 1

    decks = client.get("/api/decks").json()["decks"]
    assert decks[0]["due"] == 0
    assert decks[0]["new"] == 1

    nxt = client.get("/api/next").json()["cards"]
    assert len(nxt) == 1 and "Q2" in nxt[0]["front_html"]

    bad = client.post(f"/api/review/{card_id}", json={"rating": 9})
    assert bad.status_code == 400


def test_next_exclude_skips_current_card(client, tmp_path):
    """Preload support: the ungraded current card is still due, so skip it."""
    register(client)
    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("test.apkg", f, "application/zip")}
            ).status_code
            == 201
        )
    first = client.get("/api/next").json()["cards"][0]
    assert "Q1" in first["front_html"]
    skipped = client.get(f"/api/next?exclude={first['card_id']}").json()["cards"]
    assert len(skipped) == 1 and "Q2" in skipped[0]["front_html"]


def test_browse_search_filters_front_and_back(client, tmp_path):
    """?q= searches card text across the whole deck in the database."""
    register(client)
    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("test.apkg", f, "application/zip")}
            ).status_code
            == 201
        )
    deck_id = client.get("/api/decks").json()["decks"][0]["id"]

    def search(q):
        return client.get(f"/api/decks/{deck_id}/cards?limit=100&q={q}").json()

    assert search("Q1")["total"] == 1
    assert search("Q1")["cards"][0]["front_text"] == "Q1"
    assert search("a2")["total"] == 1  # case-insensitive back-side match
    assert search("zzz") == {"cards": [], "total": 0}
    assert search("")["total"] == 2


def test_browse_due_today_flags(client, tmp_path):
    """Browse rows say whether the card counts as due today."""
    import time

    register(client)
    now_ms = int(time.time() * 1000)
    apkg, _, _, _ = make_sched_apkg(tmp_path, now_ms)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
            ).status_code
            == 201
        )
    deck_id = client.get("/api/decks").json()["decks"][0]["id"]
    rows = client.get(f"/api/decks/{deck_id}/cards?limit=100").json()["cards"]
    flags = {r["front_text"]: r["due_today"] for r in rows}
    assert flags["LQ"] is True  # learning, due within the hour
    assert flags["RQ"] is False  # review card due months out
    assert flags["NQ"] is False  # unseen
    assert flags["SQ"] is False  # suspended


def test_google_login_creates_user_and_session(client, monkeypatch):
    from fastapi import HTTPException

    import smarthole.app as app_module

    def fake_verify(token):
        assert token == "good-token"
        return {
            "email": "guser@example.com",
            "name": "G User",
            "picture": "http://pic",
            "sub": "google-123",
        }

    monkeypatch.setattr(app_module, "verify_google_token", fake_verify)
    res = client.post("/api/google", json={"token": "good-token"})
    assert res.status_code == 200, res.text
    assert client.get("/api/me").json()["email"] == "guser@example.com"

    def bad_verify(token):
        raise HTTPException(401, "Invalid Google ID token")

    monkeypatch.setattr(app_module, "verify_google_token", bad_verify)
    res = client.post("/api/google", json={"token": "bad-token"})
    assert res.status_code == 401


def test_google_transport_imports():
    """Regression: google-auth's requests transport must be installed."""
    from google.auth.transport import requests  # noqa: F401


def test_missing_db_connection_returns_helpful_error(client):
    from mongoengine import disconnect

    register(client)
    disconnect(alias="default")
    res = client.get("/api/me")
    assert res.status_code == 500
    assert "Database not connected" in res.text


def test_config_reports_google_client_id(client, monkeypatch):
    import smarthole.app as app_module

    monkeypatch.setattr(app_module, "get_google_client_id", lambda: "test-client-id")
    assert client.get("/api/config").json() == {"googleClientId": "test-client-id"}

    def missing():
        raise RuntimeError("Missing GOOGLE_CLIENT_ID")

    monkeypatch.setattr(app_module, "get_google_client_id", missing)
    assert client.get("/api/config").json() == {"googleClientId": None}


def test_index_serves_review_page(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "marthole" in res.text  # legacy page or React shell


def _as_aware(value):
    from datetime import timezone

    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def test_import_adopts_anki_schedule(client, tmp_path):
    import time
    from datetime import datetime, timezone

    from smarthole.models import Card, CardState

    register(client)
    now_ms = int(time.time() * 1000)
    apkg, learn_due, five_days_ago, due_day = make_sched_apkg(tmp_path, now_ms)
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["imported"] == 4
    assert body["scheduling"] is True

    states = {str(s.card.id): s for s in CardState.objects()}
    by_front = {s.card.front_html: s for s in states.values()}
    assert set(by_front) == {"RQ", "LQ", "NQ", "SQ"}

    review = by_front["RQ"]
    assert review.state == 2
    assert review.stability == 100
    assert review.difficulty == pytest.approx(5.2)
    assert review.reps == 10
    assert review.lapses == 1
    expected_due = datetime.fromtimestamp(1700000000 + due_day * 86400, tz=timezone.utc)
    assert _as_aware(review.due) == expected_due

    learning = by_front["LQ"]
    assert learning.state == 1
    assert abs(_as_aware(learning.due).timestamp() - learn_due) < 120

    new = by_front["NQ"]
    assert _as_aware(new.due) <= datetime.now(timezone.utc)

    suspended_card = Card.objects(front_html="SQ").first()
    assert suspended_card.suspended is True

    decks = client.get("/api/decks").json()["decks"]
    assert decks[0]["due"] == 0
    assert decks[0]["new"] == 1  # only the new card is unseen

    nxt = client.get("/api/next").json()["cards"]
    assert len(nxt) == 1 and "NQ" in nxt[0]["front_html"]


def test_state_from_anki_day_math():
    from datetime import datetime, timezone

    from smarthole import fsrs_service as fsrs

    crt = 1700000000
    due = datetime.fromtimestamp(crt + 20000 * 86400, tz=timezone.utc)
    fields = fsrs.state_from_anki(
        {
            "type": 2,
            "queue": 2,
            "due": 20000,
            "ivl": 100,
            "factor": 2500,
            "reps": 10,
            "lapses": 1,
            "last_rev": None,
            "crt": crt,
        }
    )
    assert fields["due"] == due
    assert fields["stability"] == 100
    assert fields["state"] == 2

    # Day 0 is a real Anki day meaning due now, not a missing value.
    day_zero = fsrs.state_from_anki(
        {
            "type": 2,
            "queue": 2,
            "due": 0,
            "ivl": 8,
            "factor": 2500,
            "reps": 4,
            "lapses": 0,
            "last_rev": None,
            "crt": crt,
        }
    )
    assert day_zero["due"] == datetime.fromtimestamp(crt, tz=timezone.utc)


def test_reimport_refreshes_scheduling_but_keeps_local_reviews(client, tmp_path):
    import time

    from smarthole.models import CardState

    register(client)
    now_ms = int(time.time() * 1000)
    apkg, _, _, _ = make_sched_apkg(tmp_path, now_ms)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
            ).status_code
            == 201
        )

    new_id = next(s.card.id for s in CardState.objects() if s.card.front_html == "NQ")
    assert client.post(f"/api/review/{new_id}", json={"rating": 3}).status_code == 200

    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    assert res.json()["imported"] == 0

    by_front = {s.card.front_html: s for s in CardState.objects()}
    assert by_front["NQ"].reps == 1  # studied here: kept
    assert by_front["RQ"].stability == 100  # adopted from Anki
    assert by_front["RQ"].reps == 10


def test_stats(client, tmp_path):
    import time

    from smarthole.models import CardState

    register(client)
    now_ms = int(time.time() * 1000)
    apkg, _, _, _ = make_sched_apkg(tmp_path, now_ms)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
            ).status_code
            == 201
        )

    stats = client.get("/api/stats").json()
    assert stats["totals"] == {
        "cards": 4,
        "new": 1,
        "learning": 1,
        "review": 1,
        "suspended": 1,
        "due": 0,
    }
    assert stats["today"] == {
        "studied": 0,
        "new": 0,
        "reviews": 0,
        "accuracy": None,
    }
    assert len(stats["forecast"]) == 30
    assert [f["date"] for f in stats["forecast"]] == sorted(
        f["date"] for f in stats["forecast"]
    )

    new_id = next(s.card.id for s in CardState.objects() if s.card.front_html == "NQ")
    assert client.post(f"/api/review/{new_id}", json={"rating": 3}).status_code == 200
    stats = client.get("/api/stats").json()
    assert stats["totals"]["new"] == 0
    assert stats["totals"]["learning"] == 2
    assert stats["today"]["studied"] == 1
    assert stats["today"]["new"] == 1
    assert stats["today"]["accuracy"] == 100.0
    assert stats["forecast"][0]["due"] == 2  # graded + learning card, both due today
    assert sum(f["due"] for f in stats["forecast"]) == 2


def test_stats_requires_login(client):
    assert client.get("/api/stats").status_code == 401


def test_import_scheduled_backup(client):
    from pathlib import Path

    register(client)
    backups = Path("/mnt/c/Users/antho/AppData/Roaming/Anki2/User 1/backups")
    target = backups / "backup-2026-11-07-08.53.30.colpkg"
    if not target.exists():
        pytest.skip("scheduled backup not present")
    with open(target, "rb") as f:
        res = client.post(
            "/api/import", files={"file": (target.name, f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["scheduling"] is True
    assert body["imported"] == 1305
    assert 0 < body["due"] < 1305


def test_import_modern_apkg(client):
    from pathlib import Path

    register(client)
    apkg = Path(__file__).parent.parent / "decks.apkg"
    if not apkg.exists():
        pytest.skip("decks.apkg not present")
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("decks.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["imported"] == 1305
    assert body["scheduling"] is True
    decks = client.get("/api/decks").json()["decks"]
    assert [d["name"] for d in decks] == ["Reading"]
    assert decks[0]["new"] == 0
    assert 0 < decks[0]["due"] < 1305
    assert body["due"] == decks[0]["due"]
    due = client.get("/api/next").json()["cards"]
    assert len(due) == 1 and due[0]["front_html"].strip()
    assert ".card" not in due[0]["front_html"]  # template CSS stripped


def test_apply_rating_with_naive_stored_datetimes():
    """Atlas returns naive datetimes; grading must not blow up mixing them."""
    from datetime import datetime, timezone

    from smarthole import fsrs_service as fsrs

    now = datetime.now(timezone.utc)
    state = fsrs.apply_rating(fsrs.fresh_state(now=now), 3, now=now)
    stored = {
        **state,
        "due": state["due"].replace(tzinfo=None),
        "last_review": state["last_review"].replace(tzinfo=None),
    }
    updated = fsrs.apply_rating(stored, 3, now=now)
    assert updated["due"].tzinfo is not None
    assert updated["last_review"].tzinfo is not None


def test_strip_front_echo():
    from smarthole.app import strip_front_echo

    # Standard Anki answer template: question echoed, then <hr>, then answer.
    assert strip_front_echo("Q", "Q<hr>A") == "A"
    assert strip_front_echo("Q", "Q\n<hr id=answer>\nA") == "\nA"
    # No echo: untouched.
    assert strip_front_echo("Q", "A") == "A"
    assert strip_front_echo("Q", "Q and more, no rule") == "Q and more, no rule"
    # Answer merely starts with the same words but has no <hr>: untouched.
    assert strip_front_echo("Paris", "Paris is the capital") == "Paris is the capital"
    assert strip_front_echo("", "A") == "A"
    assert strip_front_echo("Q", "") == ""


def test_plain_text_strips_and_truncates():
    from smarthole.app import plain_text

    assert plain_text("<p>Hello <b>wor</b>ld</p>") == "Hello world"
    assert plain_text("<p>a &amp; b</p>") == "a & b"
    assert plain_text("<div>A</div><div>B</div>") == "A B"
    long = "<div>" + "x" * 200 + "</div>"
    short = plain_text(long)
    assert len(short) == 121 and short.endswith("…")
    assert plain_text("") == ""


def test_browse_deck(client, tmp_path):
    import time

    register(client)
    now_ms = int(time.time() * 1000)
    apkg, _, _, _ = make_sched_apkg(tmp_path, now_ms)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
            ).status_code
            == 201
        )
    deck_id = client.get("/api/decks").json()["decks"][0]["id"]

    rows = client.get(f"/api/decks/{deck_id}/cards").json()["cards"]
    assert len(rows) == 4
    assert {r["front_text"] for r in rows} == {"RQ", "LQ", "NQ", "SQ"}
    dues = [r["due"] for r in rows]
    assert dues == sorted(dues)  # next-due first by default
    by_text = {r["front_text"]: r for r in rows}
    assert by_text["RQ"]["last_review"] is not None  # adopted Anki history
    assert by_text["LQ"]["last_review"] is None
    assert by_text["NQ"]["last_review"] is None
    suspended = [r for r in rows if r["front_text"] == "SQ"][0]
    assert suspended["suspended"] is True

    new_id = [r for r in rows if r["front_text"] == "NQ"][0]["card_id"]
    assert client.post(f"/api/review/{new_id}", json={"rating": 3}).status_code == 200
    rows = client.get(f"/api/decks/{deck_id}/cards").json()["cards"]
    seen = [r for r in rows if r["front_text"] == "NQ"][0]
    assert seen["last_review"] is not None
    assert seen["reps"] == 1

    assert client.get("/api/decks/000000000000000000000000/cards").status_code == 404


def test_browse_pagination_and_sort(client, tmp_path):
    import time

    register(client)
    now_ms = int(time.time() * 1000)
    apkg, _, _, _ = make_sched_apkg(tmp_path, now_ms)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("sched.apkg", f, "application/zip")}
            ).status_code
            == 201
        )
    deck_id = client.get("/api/decks").json()["decks"][0]["id"]

    page1 = client.get(f"/api/decks/{deck_id}/cards?limit=2").json()
    assert page1["total"] == 4
    assert len(page1["cards"]) == 2
    page2 = client.get(f"/api/decks/{deck_id}/cards?skip=2&limit=2").json()
    assert len(page2["cards"]) == 2
    full = client.get(f"/api/decks/{deck_id}/cards?limit=100").json()["cards"]
    assert [r["due"] for r in page1["cards"] + page2["cards"]] == [
        r["due"] for r in full
    ]

    desc = client.get(
        f"/api/decks/{deck_id}/cards?sort=last_review&direction=desc&limit=100"
    ).json()["cards"]
    assert desc[0]["front_text"] == "RQ"  # only card with review history
    assert all(r["last_review"] is None for r in desc[1:])
    asc = client.get(
        f"/api/decks/{deck_id}/cards?sort=last_review&direction=asc&limit=100"
    ).json()["cards"]
    assert asc[0]["front_text"] == "RQ"  # nulls sort last either way
    assert all(r["last_review"] is None for r in asc[1:])

    assert client.get(f"/api/decks/{deck_id}/cards?limit=0").status_code == 422
    assert client.get(f"/api/decks/{deck_id}/cards?skip=-1").status_code == 422
    assert client.get(f"/api/decks/{deck_id}/cards?sort=bogus").status_code == 422


def test_browse_requires_login(client):
    assert client.get("/api/decks/whatever/cards").status_code == 401


def test_reimport_is_idempotent(client, tmp_path):
    register(client)
    apkg = make_apkg(tmp_path)
    for _ in range(2):
        with open(apkg, "rb") as f:
            res = client.post(
                "/api/import", files={"file": ("test.apkg", f, "application/zip")}
            )
        assert res.status_code == 201, res.text
    decks = client.get("/api/decks").json()["decks"]
    assert decks[0]["total"] == 2


def test_daily_new_card_budget(client, tmp_path, monkeypatch):
    import smarthole.fsrs_service as fsrs_service

    monkeypatch.setattr(fsrs_service, "NEW_CARDS_PER_DAY", 1)
    register(client)
    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        assert (
            client.post(
                "/api/import", files={"file": ("test.apkg", f, "application/zip")}
            ).status_code
            == 201
        )

    first = client.get("/api/next").json()["cards"]
    assert len(first) == 1 and "Q1" in first[0]["front_html"]
    assert (
        client.post(
            f"/api/review/{first[0]['card_id']}", json={"rating": 3}
        ).status_code
        == 200
    )
    # Budget spent: the second new card waits for tomorrow.
    assert client.get("/api/next").json()["cards"] == []
    decks = client.get("/api/decks").json()["decks"]
    assert decks[0]["due"] == 0
    assert decks[0]["new"] == 1


def test_reimport_backfills_new_position(client, tmp_path):
    from smarthole.models import Card, CardState, Deck, User

    register(client)
    user = User.objects(email="user@example.com").first()
    deck = Deck(owner=user, name="Test").save()
    card = Card(
        deck=deck, front_html="Q1", back_html="A1", anki_nid=1, anki_ord=0
    ).save()
    from smarthole import fsrs_service as fsrs

    CardState(user=user, card=card, **fsrs.fresh_state()).save()

    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("test.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    assert res.json()["imported"] == 1  # card 1 already there
    card.reload()
    assert card.new_position == 1
    state = CardState.objects(user=user, card=card).first()
    assert state.new_position == 1


def _own_deck(name="Mine"):
    from smarthole.models import Deck, User

    user = User.objects(email="user@example.com").first()
    return Deck(owner=user, name=name).save()


def test_create_card_then_visible_in_browse(client):
    from smarthole.models import Card, CardState

    register(client)
    deck = _own_deck()
    res = client.post(
        "/api/cards",
        json={"deck_id": str(deck.id), "front": "What is 2+2?", "back": "4"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["deck_id"] == str(deck.id)
    card_id = body["card_id"]

    rows = client.get(f"/api/decks/{deck.id}/cards").json()["cards"]
    assert any(
        r["card_id"] == card_id and r["front_text"] == "What is 2+2?" for r in rows
    )

    first = Card.objects(id=card_id).first()
    res2 = client.post(
        "/api/cards",
        json={"deck_id": str(deck.id), "front": "Second", "back": "Two"},
    )
    assert res2.status_code == 201, res2.text
    second = Card.objects(id=res2.json()["card_id"]).first()
    assert second.new_position == (first.new_position or 0) + 1
    state = CardState.objects(card=second).first()
    assert state is not None and state.reps == 0
    assert state.new_position == second.new_position


def test_create_card_foreign_deck_404(client):
    from smarthole.models import Deck, User

    register(client)
    other = User(email="other@example.com", pw_hash="x").save()
    theirs = Deck(owner=other, name="Theirs").save()
    res = client.post(
        "/api/cards",
        json={"deck_id": str(theirs.id), "front": "Q", "back": "A"},
    )
    assert res.status_code == 404
    res = client.post(
        "/api/cards",
        json={
            "deck_id": "000000000000000000000000",
            "front": "Q",
            "back": "A",
        },
    )
    assert res.status_code == 404


def test_create_card_requires_login(client):
    register(client)
    deck = _own_deck()
    payload = {"deck_id": str(deck.id), "front": "Q", "back": "A"}
    client.cookies.clear()
    res = client.post("/api/cards", json=payload)
    assert res.status_code == 401


def test_create_card_sanitizes_markup(client):
    from smarthole.models import Card

    register(client)
    deck = _own_deck()
    res = client.post(
        "/api/cards",
        json={
            "deck_id": str(deck.id),
            "front": '<script>alert(1)</script><b>hi</b><img src="x" onerror="evil()">',
            "back": 'ok<style>p{color:red}</style><i>there</i><a href="http://e.com" onclick="evil()">link</a>',
        },
    )
    assert res.status_code == 201, res.text
    card = Card.objects(id=res.json()["card_id"]).first()
    assert "script" not in card.front_html
    assert "<b>hi</b>" in card.front_html
    assert "onerror" not in card.front_html
    assert "style" not in card.back_html.lower() or "<style" not in card.back_html
    assert "<i>there</i>" in card.back_html
    assert "onclick" not in card.back_html


def _stream_lines(res):
    lines = [json.loads(line) for line in res.text.splitlines() if line.strip()]
    assert lines, "expected NDJSON progress lines"
    return lines


def test_import_stream_reports_progress(client, tmp_path):
    register(client)
    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import?stream=true",
            files={"file": ("test.apkg", f, "application/zip")},
        )
    assert res.status_code == 200, res.text
    assert "x-ndjson" in res.headers["content-type"]
    lines = _stream_lines(res)
    stages = [line.get("stage") for line in lines]
    assert stages[0] == "upload"
    assert "parse" in stages and "save" in stages
    parse_final = [line for line in lines if line.get("stage") == "parse"][-1]
    assert parse_final["done"] == parse_final["total"] == 2
    save_final = [line for line in lines if line.get("stage") == "save"][-1]
    assert save_final["done"] == save_final["total"] == 2
    complete = [line for line in lines if line.get("complete")]
    assert len(complete) == 1
    assert complete[0]["result"]["imported"] == 2
    assert not any("error" in line for line in lines)


def test_import_stream_bad_package(client, tmp_path):
    register(client)
    bad = tmp_path / "bad.apkg"
    bad.write_bytes(b"not a zip file")
    with open(bad, "rb") as f:
        res = client.post(
            "/api/import?stream=true",
            files={"file": ("bad.apkg", f, "application/zip")},
        )
    assert res.status_code == 200, res.text
    lines = _stream_lines(res)
    assert any("error" in line for line in lines)
    assert not any(line.get("complete") for line in lines)


def test_decks_reports_due_today(client, tmp_path):
    from datetime import datetime, timedelta, timezone

    from smarthole.models import CardState

    register(client)
    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("test.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    now = datetime.now(timezone.utc)
    states = list(CardState.objects())
    assert len(states) == 2
    states[0].update(set__reps=3, set__due=now - timedelta(hours=1))
    later = now + timedelta(hours=2)
    states[1].update(set__reps=2, set__due=later)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    expected_today = 2 if later < day_start + timedelta(days=1) else 1
    decks = client.get("/api/decks").json()["decks"]
    assert len(decks) == 1
    assert decks[0]["due"] == 1
    assert decks[0]["new"] == 0
    assert decks[0]["due_today"] == expected_today
