"""Browser login + consent for the smarthole MCP OAuth flow.

GET /oauth/mcp-login?ticket=… renders a Google sign-in page for the pending
authorization request; POST /oauth/mcp-consent verifies the Google ID token,
checks the account, consumes the ticket, and issues a single-use
authorization code, redirecting the browser back to the OAuth client.
"""

import html
import logging
import os
import secrets
from datetime import timezone

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from .mcp_oauth_models import MCPAuthCode, MCPLoginTicket
from .mcp_oauth_provider import (
    AUTH_CODE_TTL,
    _utcnow,
    build_consent_redirect,
    get_or_create_user_from_google,
    verify_google_id_token,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp-oauth"])


class ConsentIn(BaseModel):
    ticket: str
    id_token: str


def _login_page(ticket_id: str, client_name: str | None, scopes: list[str]) -> str:
    google_client_id = html.escape(os.getenv("GOOGLE_CLIENT_ID", ""))
    safe_ticket = html.escape(ticket_id)
    safe_client = html.escape(client_name or "an MCP client")
    safe_scopes = "".join(f"<li>{html.escape(s)}</li>" for s in scopes) or "<li>—</li>"
    has_write = "cards:write" in scopes
    if has_write:
        access_blurb = (
            "read access to your deck list and write access to create "
            "new Anki cards in your smarthole decks."
        )
    else:
        access_blurb = "read-only access to your smarthole deck list."
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>smarthole access request</title>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<style>body{{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}}</style>
</head>
<body>
<h1>smarthole access request</h1>
<p><strong>{safe_client}</strong> is requesting {access_blurb}</p>
<ul>{safe_scopes}</ul>
<div id="g_id_onload" data-client_id="{google_client_id}" data-callback="onGoogle" data-auto_prompt="false"></div>
<div class="g_id_signin" data-type="standard" data-size="large"></div>
<p id="err" style="color:#b00"></p>
<script>
async function onGoogle(resp) {{
  const r = await fetch("/oauth/mcp-consent", {{method: "POST",
    headers: {{"Content-Type": "application/json"}},
    body: JSON.stringify({{ticket: "{safe_ticket}", id_token: resp.credential}})}});
  const data = await r.json();
  if (r.ok && data.redirect_to) {{ window.location = data.redirect_to; return; }}
  document.getElementById("err").textContent = (data && data.detail) || "Sign-in failed";
}}
</script>
</body>
</html>"""


@router.get("/oauth/mcp-login", response_class=HTMLResponse)
def mcp_login(ticket: str):
    """Render the Google sign-in / consent page for a pending ticket."""
    doc = MCPLoginTicket.objects(ticket=ticket).first()
    if doc is None or doc.consumed:
        return HTMLResponse("<h1>Invalid or expired request</h1>", status_code=400)
    if doc.expires_at.replace(tzinfo=timezone.utc) < _utcnow():
        return HTMLResponse(
            "<h1>Request expired — please try again</h1>", status_code=400
        )
    return HTMLResponse(
        _login_page(doc.ticket, doc.client_name, list(doc.scopes or []))
    )


@router.post("/oauth/mcp-consent")
def mcp_consent(body: ConsentIn):
    """Verify Google sign-in, consume the ticket, issue an auth code."""
    claimed = MCPLoginTicket.objects(ticket=body.ticket, consumed=False).modify(
        new=True, set__consumed=True
    )
    if claimed is None:
        return JSONResponse(
            {"detail": "Invalid or already-used request"}, status_code=400
        )
    if claimed.expires_at.replace(tzinfo=timezone.utc) < _utcnow():
        return JSONResponse(
            {"detail": "Request expired — please try again"}, status_code=400
        )
    try:
        claims = verify_google_id_token(body.id_token)
        user = get_or_create_user_from_google(claims)
    except Exception as e:
        logger.info("MCP consent Google verification failed: %s", type(e).__name__)
        return JSONResponse({"detail": "Google sign-in failed"}, status_code=401)
    code = secrets.token_urlsafe(32)
    MCPAuthCode(
        code=code,
        client_id=claimed.client_id,
        user_email=user.email,
        scopes=list(claimed.scopes or []),
        code_challenge=claimed.code_challenge,
        redirect_uri=claimed.redirect_uri,
        resource=claimed.resource,
        expires_at=_utcnow() + AUTH_CODE_TTL,
    ).save()
    logger.info("MCP auth code issued for user")
    return {"redirect_to": build_consent_redirect(claimed, code)}
