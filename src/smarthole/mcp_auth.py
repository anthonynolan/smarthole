"""Bearer-token verification for the smarthole MCP server.

Accepts two credential kinds (tried in order):

1. MCP access tokens — short-lived HS256 JWTs minted by
   :mod:`smarthole.mcp_oauth_provider` (``type="mcp_access"``).
2. Google ID tokens (verify via ``GOOGLE_CLIENT_ID``) — convenient for MCP
   Inspector / CLI use without running the OAuth flow.
"""

from __future__ import annotations

import logging

from mcp.server.auth.provider import AccessToken, TokenVerifier

from .mcp_oauth_models import MCPRevokedToken
from .models import User

logger = logging.getLogger(__name__)

MCP_SCOPES = ["cards:read", "cards:write"]
CARDS_READ_SCOPE = "cards:read"
CARDS_WRITE_SCOPE = "cards:write"


class SmartholeTokenVerifier(TokenVerifier):
    """Validate MCP access JWTs first, Google ID tokens second."""

    def __init__(self, resource_url: str | None = None):
        self.resource_url = resource_url

    async def verify_token(self, token: str) -> AccessToken | None:
        access = await self._verify_mcp_access_token(token)
        if access is not None:
            return access
        return await self._verify_google_id_token(token)

    async def _verify_mcp_access_token(self, token: str) -> AccessToken | None:
        from .mcp_oauth_provider import decode_access_token

        claims = decode_access_token(token)
        if claims is None:
            return None
        audience = (claims.get("aud") or "").rstrip("/")
        if self.resource_url and audience != self.resource_url.rstrip("/"):
            logger.info("MCP token rejected: audience mismatch")
            return None
        if MCPRevokedToken.objects(jti=claims.get("jti")).first() is not None:
            logger.info("MCP token rejected: revoked")
            return None
        email = claims.get("sub") or ""
        if User.objects(email=email).first() is None:
            return None
        scopes = [s for s in (claims.get("scope") or "").split() if s in MCP_SCOPES]
        return AccessToken(
            token=token,
            client_id=claims.get("client_id") or "",
            scopes=scopes,
            expires_at=int(claims["exp"]),
            resource=claims.get("aud"),
            subject=email,
        )

    async def _verify_google_id_token(self, token: str) -> AccessToken | None:
        import os

        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token as google_id_token

        client_id = os.getenv("GOOGLE_CLIENT_ID")
        if not client_id:
            return None
        try:
            info = google_id_token.verify_oauth2_token(
                token, google_requests.Request(), client_id
            )
        except Exception as e:
            logger.info("MCP token rejected: %s", type(e).__name__)
            return None
        email = (info.get("email") or "").lower()
        if not email or User.objects(email=email).first() is None:
            return None
        return AccessToken(
            token=token,
            client_id="google-id-token",
            scopes=list(MCP_SCOPES),
            subject=email,
        )
