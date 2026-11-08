"""smarthole MCP OAuth 2.1 authorization server (ported from grimoire-service).

MongoDB-backed provider implementing the MCP SDK's
``OAuthAuthorizationServerProvider`` protocol: DCR clients, authorize stash +
redirect to Google sign-in, PKCE auth codes, short-lived stateless access
JWTs + rotating refresh tokens with family-based reuse detection.
"""

from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from jose import JWTError, jwt
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    OAuthClientInformationFull,
    OAuthToken,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)

from .mcp_oauth_models import (
    MCPAuthCode,
    MCPLoginTicket,
    MCPOAuthClient,
    MCPRefreshToken,
    MCPRevokedToken,
)
from .models import User

logger = logging.getLogger(__name__)

AUTH_CODE_TTL = timedelta(minutes=10)
LOGIN_TICKET_TTL = timedelta(minutes=15)
ACCESS_TOKEN_TTL = timedelta(minutes=15)
REFRESH_TOKEN_TTL = timedelta(days=30)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_ts() -> float:
    return time.time()


def get_oauth_secret_key() -> str:
    import os

    return os.environ.get("SECRET_KEY", "your-secret-key-fallback")


def mint_access_token(
    user_email: str, scopes: list[str], resource: str | None, client_id: str
) -> tuple[str, str, int]:
    """Return (jwt, jti, expires_in_seconds) for an MCP access token."""
    now = int(_utcnow_ts())
    expires_in = int(ACCESS_TOKEN_TTL.total_seconds())
    jti = secrets.token_hex(16)
    payload: dict[str, Any] = {
        "sub": user_email,
        "scope": " ".join(scopes),
        "aud": resource,
        "client_id": client_id,
        "jti": jti,
        "type": "mcp_access",
        "iat": now,
        "exp": now + expires_in,
    }
    return (
        jwt.encode(payload, get_oauth_secret_key(), algorithm="HS256"),
        jti,
        expires_in,
    )


def decode_access_token(token: str, verify_exp: bool = True) -> dict | None:
    try:
        claims = jwt.decode(
            token,
            get_oauth_secret_key(),
            algorithms=["HS256"],
            options={"verify_exp": verify_exp, "verify_aud": False},
        )
    except JWTError:
        return None
    if claims.get("type") != "mcp_access":
        return None
    return claims


def verify_google_id_token(id_token_str: str) -> dict:
    """Verify a Google Identity Services ID token; return its claims."""
    import os

    client_id = os.getenv("GOOGLE_CLIENT_ID")
    if not client_id:
        raise RuntimeError("Missing GOOGLE_CLIENT_ID")
    return google_id_token.verify_oauth2_token(
        id_token_str, google_requests.Request(), client_id
    )


def get_or_create_user_from_google(claims: dict) -> User:
    """Mirror /api/google provisioning for OAuth-consented users."""
    email = (claims.get("email") or "").lower()
    if not email:
        raise ValueError("Google token has no email claim")
    user = User.objects(email=email).first()
    if not user:
        user = User(
            email=email,
            name=claims.get("name", ""),
            picture=claims.get("picture", ""),
            google_sub=claims.get("sub", ""),
        ).save()
        logger.info("Created new user via MCP OAuth: %s", email)
    return user


class SmartholeOAuthProvider:
    """OAuthAuthorizationServerProvider backed by MongoDB (structural typing)."""

    def __init__(self, resource_url: str, allowed_scopes: list[str]):
        self.resource_url = resource_url
        self.allowed_scopes = list(allowed_scopes)

    def _client_to_info(self, doc: MCPOAuthClient) -> OAuthClientInformationFull:
        return OAuthClientInformationFull(
            client_id=doc.client_id,
            client_secret=doc.client_secret,
            redirect_uris=list(doc.redirect_uris or []),
            token_endpoint_auth_method=doc.token_endpoint_auth_method
            or "client_secret_post",
            grant_types=list(
                doc.grant_types or ["authorization_code", "refresh_token"]
            ),
            response_types=list(doc.response_types or ["code"]),
            scope=doc.scope,
            client_name=doc.client_name,
        )

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        if not client_id:
            return None
        doc = MCPOAuthClient.objects(client_id=client_id).first()
        return self._client_to_info(doc) if doc else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        redirect_uris = [str(u) for u in client_info.redirect_uris or []]
        if not redirect_uris:
            raise RegistrationError(
                "invalid_redirect_uri", "At least one redirect_uri is required"
            )
        for uri in redirect_uris:
            if uri.startswith("https://"):
                continue
            if uri.startswith("http://localhost") or uri.startswith("http://127.0.0.1"):
                continue
            raise RegistrationError(
                "invalid_redirect_uri",
                f"redirect_uri must be https (or http localhost for testing): {uri}",
            )
        if client_info.token_endpoint_auth_method not in (
            None,
            "none",
            "client_secret_post",
            "client_secret_basic",
        ):
            raise RegistrationError(
                "invalid_client_metadata",
                "token_endpoint_auth_method must be one of none, "
                "client_secret_post, client_secret_basic",
            )
        MCPOAuthClient(
            client_id=client_info.client_id,
            client_secret=client_info.client_secret,
            redirect_uris=redirect_uris,
            token_endpoint_auth_method=client_info.token_endpoint_auth_method
            or "client_secret_post",
            grant_types=list(client_info.grant_types or []),
            response_types=list(client_info.response_types or []),
            scope=client_info.scope,
            client_name=client_info.client_name,
        ).save()
        logger.info("Registered MCP OAuth client: %s", client_info.client_name)

    def _check_resource(self, resource: str | None) -> None:
        if resource is not None and resource.rstrip("/") != self.resource_url.rstrip(
            "/"
        ):
            raise AuthorizeError(
                "invalid_target",
                f"resource must be {self.resource_url}",
            )

    def _resolve_scopes(self, requested: list[str] | None) -> list[str]:
        if not requested:
            return list(self.allowed_scopes)
        unknown = [s for s in requested if s not in self.allowed_scopes]
        if unknown:
            raise AuthorizeError(
                "invalid_scope", f"Unknown scopes requested: {', '.join(unknown)}"
            )
        return list(requested)

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        self._check_resource(params.resource)
        scopes = self._resolve_scopes(params.scopes)
        resource = params.resource or self.resource_url
        ticket = secrets.token_urlsafe(32)
        MCPLoginTicket(
            ticket=ticket,
            client_id=client.client_id or "",
            redirect_uri=str(params.redirect_uri),
            scopes=scopes,
            state=params.state,
            code_challenge=params.code_challenge,
            resource=resource,
            client_name=client.client_name,
            expires_at=_utcnow() + LOGIN_TICKET_TTL,
        ).save()
        return f"/oauth/mcp-login?ticket={ticket}"

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        if not authorization_code:
            return None
        doc = MCPAuthCode.objects(code=authorization_code).first()
        if doc is None or doc.client_id != (client.client_id or ""):
            return None
        if doc.used:
            return None
        if doc.expires_at.replace(tzinfo=timezone.utc) < _utcnow():
            return AuthorizationCode(
                code=doc.code,
                scopes=list(doc.scopes or []),
                expires_at=doc.expires_at.replace(tzinfo=timezone.utc).timestamp(),
                client_id=doc.client_id,
                code_challenge=doc.code_challenge,
                redirect_uri=doc.redirect_uri,  # type: ignore[arg-type]
                redirect_uri_provided_explicitly=True,
                resource=doc.resource,
                subject=doc.user_email,
            )
        claimed = MCPAuthCode.objects(code=doc.code, used=False).modify(set__used=True)
        if claimed is None:
            return None
        return AuthorizationCode(
            code=doc.code,
            scopes=list(doc.scopes or []),
            expires_at=doc.expires_at.replace(tzinfo=timezone.utc).timestamp(),
            client_id=doc.client_id,
            code_challenge=doc.code_challenge,
            redirect_uri=doc.redirect_uri,  # type: ignore[arg-type]
            redirect_uri_provided_explicitly=True,
            resource=doc.resource,
            subject=doc.user_email,
        )

    def _issue_token_pair(
        self,
        client_id: str,
        user_email: str,
        scopes: list[str],
        resource: str | None,
    ) -> OAuthToken:
        access, _jti, expires_in = mint_access_token(
            user_email, scopes, resource, client_id
        )
        refresh = MCPRefreshToken(
            token=secrets.token_urlsafe(32),
            family_id=secrets.token_hex(16),
            client_id=client_id,
            user_email=user_email,
            scopes=scopes,
            resource=resource,
            expires_at=_utcnow() + REFRESH_TOKEN_TTL,
        )
        refresh.save()
        return OAuthToken(
            access_token=access,
            expires_in=expires_in,
            scope=" ".join(scopes),
            refresh_token=refresh.token,
        )

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        if (client.client_id or "") != authorization_code.client_id:
            raise TokenError("invalid_grant", "authorization code client mismatch")
        subject = authorization_code.subject or ""
        if not subject:
            raise TokenError("invalid_grant", "authorization code has no subject")
        if User.objects(email=subject).first() is None:
            raise TokenError("invalid_grant", "account unavailable")
        return self._issue_token_pair(
            client.client_id or "",
            subject,
            list(authorization_code.scopes or []),
            authorization_code.resource,
        )

    def _refresh_to_model(self, doc: MCPRefreshToken) -> RefreshToken:
        return RefreshToken(
            token=doc.token,
            client_id=doc.client_id,
            scopes=list(doc.scopes or []),
            expires_at=int(doc.expires_at.replace(tzinfo=timezone.utc).timestamp()),
            subject=doc.user_email,
        )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        if not refresh_token:
            return None
        doc = MCPRefreshToken.objects(token=refresh_token).first()
        if doc is None or doc.client_id != (client.client_id or ""):
            return None
        return self._refresh_to_model(doc)

    def _revoke_family(self, family_id: str) -> None:
        MCPRefreshToken.objects(family_id=family_id, revoked=False).update(
            set__revoked=True
        )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        doc = MCPRefreshToken.objects(token=refresh_token.token).first()
        if doc is None or doc.client_id != (client.client_id or ""):
            raise TokenError("invalid_grant", "refresh token does not exist")
        if doc.revoked:
            self._revoke_family(doc.family_id)
            logger.warning("MCP refresh token reuse detected; family revoked")
            raise TokenError("invalid_grant", "refresh token has been rotated")
        if doc.expires_at.replace(tzinfo=timezone.utc) < _utcnow():
            raise TokenError("invalid_grant", "refresh token has expired")
        if User.objects(email=doc.user_email).first() is None:
            raise TokenError("invalid_grant", "account unavailable")
        granted = list(doc.scopes or [])
        if scopes:
            unknown = [s for s in scopes if s not in granted]
            if unknown:
                raise TokenError(
                    "invalid_scope",
                    f"cannot request scopes not granted: {', '.join(unknown)}",
                )
            granted = list(scopes)
        new_token_str = secrets.token_urlsafe(32)
        new_doc = MCPRefreshToken(
            token=new_token_str,
            family_id=doc.family_id,
            client_id=doc.client_id,
            user_email=doc.user_email,
            scopes=granted,
            resource=doc.resource,
            expires_at=_utcnow() + REFRESH_TOKEN_TTL,
            replaces=doc.token,
        )
        new_doc.save()
        MCPRefreshToken.objects(token=doc.token).update(
            set__revoked=True, set__replaces=new_token_str
        )
        access, _jti, expires_in = mint_access_token(
            doc.user_email, granted, doc.resource, doc.client_id
        )
        return OAuthToken(
            access_token=access,
            expires_in=expires_in,
            scope=" ".join(granted),
            refresh_token=new_token_str,
        )

    async def load_access_token(self, token: str) -> AccessToken | None:
        claims = decode_access_token(token)
        if claims is None:
            return None
        audience = (claims.get("aud") or "").rstrip("/")
        if audience != self.resource_url.rstrip("/"):
            return None
        if MCPRevokedToken.objects(jti=claims.get("jti")).first() is not None:
            return None
        scopes = (claims.get("scope") or "").split()
        return AccessToken(
            token=token,
            client_id=claims.get("client_id") or "",
            scopes=scopes,
            expires_at=int(claims["exp"]),
            resource=claims.get("aud"),
            subject=claims.get("sub"),
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        raw = token.token
        claims = decode_access_token(raw, verify_exp=False)
        if claims is not None and claims.get("jti"):
            exp = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
            if exp > _utcnow():
                MCPRevokedToken(
                    jti=claims["jti"], expires_at=exp, reason="revocation endpoint"
                ).save()
            return
        doc = MCPRefreshToken.objects(token=raw).first()
        if doc is not None:
            self._revoke_family(doc.family_id)


def build_consent_redirect(ticket_doc: MCPLoginTicket, code: str) -> str:
    """Redirect URL back to the OAuth client with code (+ state)."""
    return construct_redirect_uri(
        ticket_doc.redirect_uri, code=code, state=ticket_doc.state
    )
