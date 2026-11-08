"""MongoEngine storage for the smarthole MCP OAuth 2.1 authorization server.

Mirrors the grimoire-service pattern: DCR-registered clients, single-use
authorization codes, refresh-token families (rotation/reuse detection), and
revoked access-token JTIs. Access tokens themselves are stateless JWTs.
"""

from datetime import datetime, timezone

from mongoengine import Document
from mongoengine.fields import (
    BooleanField,
    DateTimeField,
    ListField,
    StringField,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MCPOAuthClient(Document):
    """A dynamically-registered (RFC 7591) OAuth client, e.g. ChatGPT."""

    client_id = StringField(primary_key=True, required=True)
    client_secret = StringField(required=False)
    redirect_uris = ListField(StringField(), required=True)
    token_endpoint_auth_method = StringField(
        required=True, default="client_secret_post"
    )
    grant_types = ListField(StringField(), default=list)
    response_types = ListField(StringField(), default=list)
    scope = StringField(required=False)
    client_name = StringField(required=False)
    created_date = DateTimeField(default=_utcnow)

    meta = {"collection": "mcp_oauth_clients"}


class MCPAuthCode(Document):
    """Single-use authorization code (PKCE flow)."""

    code = StringField(primary_key=True, required=True)
    client_id = StringField(required=True)
    user_email = StringField(required=True)
    scopes = ListField(StringField(), default=list)
    code_challenge = StringField(required=True)
    redirect_uri = StringField(required=True)
    resource = StringField(required=False)
    expires_at = DateTimeField(required=True)
    used = BooleanField(default=False)
    created_date = DateTimeField(default=_utcnow)

    meta = {"collection": "mcp_auth_codes"}


class MCPRefreshToken(Document):
    """Refresh token with rotation; reuse of a rotated token revokes the family."""

    token = StringField(primary_key=True, required=True)
    family_id = StringField(required=True)
    client_id = StringField(required=True)
    user_email = StringField(required=True)
    scopes = ListField(StringField(), default=list)
    resource = StringField(required=False)
    expires_at = DateTimeField(required=True)
    revoked = BooleanField(default=False)
    replaces = StringField(required=False)
    created_date = DateTimeField(default=_utcnow)

    meta = {"collection": "mcp_refresh_tokens"}


class MCPRevokedToken(Document):
    """JTI blocklist for stateless MCP access tokens."""

    jti = StringField(primary_key=True, required=True)
    expires_at = DateTimeField(required=True)
    reason = StringField(required=False, default="")
    created_date = DateTimeField(default=_utcnow)

    meta = {"collection": "mcp_revoked_tokens"}


class MCPLoginTicket(Document):
    """Short-lived record binding an /authorize request to a later consent."""

    ticket = StringField(primary_key=True, required=True)
    client_id = StringField(required=True)
    redirect_uri = StringField(required=True)
    scopes = ListField(StringField(), default=list)
    state = StringField(required=False)
    code_challenge = StringField(required=True)
    resource = StringField(required=False)
    client_name = StringField(required=False)
    expires_at = DateTimeField(required=True)
    consumed = BooleanField(default=False)
    created_date = DateTimeField(default=_utcnow)

    meta = {"collection": "mcp_login_tickets"}
