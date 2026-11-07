"""Cookie session auth: server-side sessions, scrypt password hashes (stdlib).

Google sign-in mirrors the grimoire flow: the browser gets a Google ID token
via Google Identity Services, posts it to the backend, the backend verifies it
against GOOGLE_CLIENT_ID and mints a normal session cookie.
"""

import hashlib
import logging
import os
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Cookie, Depends, HTTPException, status

from .models import Session, User

logger = logging.getLogger(__name__)

SESSION_COOKIE = "smarthole_session"
SESSION_DAYS = 30


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, pw_hash: str | None) -> bool:
    if not pw_hash:
        return False
    try:
        salt_hex, digest_hex = pw_hash.split("$")
    except ValueError:
        return False
    digest = hashlib.scrypt(
        password.encode(), salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1
    )
    return secrets.compare_digest(digest.hex(), digest_hex)


def create_session(user: User) -> Session:
    return Session(
        session_id=secrets.token_urlsafe(32),
        user=user,
        expires_at=datetime.now(UTC) + timedelta(days=SESSION_DAYS),
    ).save()


def destroy_session(session_id: str) -> None:
    Session.objects(session_id=session_id).delete()


def get_current_user(
    session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> User:
    if not session_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    session = Session.objects(session_id=session_id).first()
    if session is None or session.expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    return session.user


def get_google_client_id() -> str:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    if not client_id:
        raise RuntimeError("Missing GOOGLE_CLIENT_ID")
    return client_id


def verify_google_token(id_token_str: str) -> dict:
    """Verify a Google ID token; return email/name/picture/sub on success."""
    from google.auth.transport import requests
    from google.oauth2 import id_token

    try:
        idinfo = id_token.verify_oauth2_token(
            id_token_str, requests.Request(), get_google_client_id()
        )
    except ValueError as exc:
        logger.warning("Google ID token verification failed: %s", exc)
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid Google ID token"
        ) from exc
    email = (idinfo.get("email") or "").lower()
    if not email:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid Google ID token")
    return {
        "email": email,
        "name": idinfo.get("name", ""),
        "picture": idinfo.get("picture", ""),
        "sub": idinfo.get("sub", ""),
    }


CurrentUser = Depends(get_current_user)
