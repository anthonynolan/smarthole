"""Admin-only overwrite of the dev database with production data."""

import os

os.environ["TESTING"] = "1"
os.environ.setdefault("MCP_ALLOWED_HOSTS", "testserver")
os.environ.setdefault("SECRET_KEY", "test-secret-key")

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect
from mongoengine.connection import get_db

from smarthole import app as app_module
from smarthole import mongo_connection


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_admin_overwrite_test",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def register(client, email):
    res = client.post("/api/register", json={"email": email, "password": "secret123"})
    assert res.status_code == 201, res.text


def test_overwrite_requires_admin(client):
    register(client, "user@example.com")
    res = client.post(
        "/api/admin/overwrite-dev-from-prod", json={"confirm": "overwrite-dev"}
    )
    assert res.status_code == 403, res.text


def test_overwrite_requires_confirm(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    register(client, "admin@example.com")
    assert client.post("/api/admin/overwrite-dev-from-prod", json={}).status_code == 400
    res = client.post(
        "/api/admin/overwrite-dev-from-prod", json={"confirm": "yes"}
    )
    assert res.status_code == 400, res.text
    assert "confirm" in res.text


def test_overwrite_copies_prod_into_dev(client, monkeypatch):
    prod_name = "staged_prod_db"
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    monkeypatch.setenv("PROD_MONGO_DB_NAME", prod_name)
    register(client, "admin@example.com")

    current = get_db()
    prod = current.client[prod_name]
    prod["decks"].insert_many(
        [{"name": "Prod Deck A"}, {"name": "Prod Deck B"}]
    )
    prod["cards"].insert_one({"front_html": "PQ", "back_html": "PA"})
    current["decks"].insert_one({"name": "Dev Deck"})
    assert current["decks"].count_documents({}) == 1

    res = client.post(
        "/api/admin/overwrite-dev-from-prod", json={"confirm": "overwrite-dev"}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["overwritten"] is True
    assert body["from"] == prod_name
    assert body["to"] == current.name
    assert body["collections"]["decks"] == 2
    assert body["collections"]["cards"] == 1
    assert body["relogin_required"] is True

    assert sorted(d["name"] for d in current["decks"].find({})) == [
        "Prod Deck A",
        "Prod Deck B",
    ]
    assert current["cards"].find_one({})["front_html"] == "PQ"


def test_overwrite_refuses_empty_prod(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    monkeypatch.setenv("PROD_MONGO_DB_NAME", "empty_prod_db")
    register(client, "admin@example.com")
    res = client.post(
        "/api/admin/overwrite-dev-from-prod", json={"confirm": "overwrite-dev"}
    )
    assert res.status_code == 502, res.text


def test_overwrite_refuses_on_prod_itself(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    register(client, "admin@example.com")
    monkeypatch.setattr(mongo_connection, "PROD_DB", get_db().name)
    res = client.post(
        "/api/admin/overwrite-dev-from-prod", json={"confirm": "overwrite-dev"}
    )
    assert res.status_code == 400, res.text
    assert "production" in res.text
