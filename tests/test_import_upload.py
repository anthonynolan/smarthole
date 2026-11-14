"""Import upload must stream to disk, not slurp the whole file into RAM."""

import os

os.environ["TESTING"] = "1"

import mongomock
import pytest
from fastapi.testclient import TestClient
from mongoengine import connect, disconnect

from smarthole import app as app_module
from test_review_flow import make_apkg, register


@pytest.fixture()
def client():
    disconnect(alias="default")
    connect(
        "smarthole_test_upload",
        alias="default",
        mongo_client_class=mongomock.MongoClient,
    )
    with TestClient(app_module.app) as c:
        yield c
    disconnect(alias="default")


def test_import_streams_upload_to_disk(client, tmp_path, monkeypatch):
    import shutil

    calls = []
    real_copyfileobj = shutil.copyfileobj

    def spy_copy(src, dst, *args, **kwargs):
        calls.append(True)
        return real_copyfileobj(src, dst, *args, **kwargs)

    monkeypatch.setattr(shutil, "copyfileobj", spy_copy)
    register(client)
    apkg = make_apkg(tmp_path)
    with open(apkg, "rb") as f:
        res = client.post(
            "/api/import", files={"file": ("test.apkg", f, "application/zip")}
        )
    assert res.status_code == 201, res.text
    assert calls, "upload was not streamed with shutil.copyfileobj"
    assert res.json()["imported"] == 2
