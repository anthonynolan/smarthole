# smarthole MCP Server

Exposes deck **read** + card **write** tools from the smarthole FastAPI
service over MCP Streamable HTTP, for external AI clients (ChatGPT
connectors / Apps, MCP Inspector, Claude Code, Cursor, …). Pattern mirrors
`grimoire-service` (`docs/mcp.md` there); code lives in
`src/smarthole/mcp_server.py`, `mcp_auth.py`, `mcp_oauth_provider.py`,
`mcp_oauth_models.py`, `mcp_oauth_routes.py`, mounted in `app.py`.

- URL (prod): `https://smarthole.cathalanddad.com/mcp`
- URL (local): `http://localhost:8123/mcp`
- Discovery: `GET /.well-known/oauth-protected-resource/mcp`
- Code: `src/smarthole/mcp_server.py`, `mcp_auth.py`,
  `mcp_oauth_provider.py`, `mcp_oauth_models.py`, `mcp_oauth_routes.py`

## Tools

| Tool | Source | Scope |
|---|---|---|
| `list_decks()` | caller's decks with card counts | `cards:read` |
| `create_card(deck_id, front, back)` | create one card (FSRS-new) in a deck | `cards:write` |

Tools share the same code path as the REST routes (`POST /api/cards`):
front/back are sanitized the same way and the card starts in the same
fresh FSRS state. The caller's identity always comes from the verified
Bearer token (`get_access_token().subject` = smarthole email); tools take
no user id. Service errors become MCP `ToolError` so clients can tell
"not found" from failures.

## Auth: Bearer + OAuth 2.1 (shipped)

Two credential kinds are accepted (tried in order):

1. **MCP access tokens** — short-lived HS256 JWTs minted by the built-in
   OAuth 2.1 authorization server (same DCR + PKCE + Google-sign-in flow
   as grimoire): `POST /register`, `GET /authorize` →
   `GET /oauth/mcp-login` (Google Identity Services, existing
   `GOOGLE_CLIENT_ID`) → `POST /oauth/mcp-consent` → `POST /token`
   (15-min access JWT + 30-day rotating refresh token) → `POST /revoke`.
   Discovery: `/.well-known/oauth-authorization-server` and
   `/.well-known/oauth-protected-resource/mcp`.
2. **Google ID tokens** as a Bearer directly (verified against
   `GOOGLE_CLIENT_ID`, account must exist). Convenient for MCP Inspector /
   CLI use without running the OAuth flow — paste a fresh Google ID token
   as the Bearer.

To connect ChatGPT: Settings → Connectors → add MCP server
`https://smarthole.cathalanddad.com/mcp` → complete the Google sign-in
when redirected → approve access. The consent screen calls out that
`cards:write` can create new Anki cards in your decks.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `MCP_ENABLED` | `1` | set `0` to disable `/mcp` entirely |
| `SECRET_KEY` | — (required) | signs MCP access JWTs; generate with `openssl rand -hex 32`, add to `.env.prod` |
| `MCP_RESOURCE_URL` | `https://smarthole.cathalanddad.com/mcp` | RFC 8707 resource id / metadata |
| `MCP_ISSUER_URL` | `https://smarthole.cathalanddad.com` | OAuth issuer (AS lives here) |
| `MCP_PUBLIC_BASE_URL` | `https://smarthole.cathalanddad.com` | base used in well-known metadata |
| `MCP_STATELESS` | `0` | set `1` for multi-worker (no session stickiness) |
| `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` | — | comma-separated extras for DNS-rebinding protection (prod host is auto-allowed) |

Local dev uses `http://localhost:8123` for all three URLs (see
`.env.example`). Single uvicorn worker works in stateful mode.

`SECRET_KEY` is new: the server `.env` (from `.env.prod`) must define it
before `/mcp` can mint tokens — Bearer auth falls back to Google ID
tokens only when it is missing/unset on the signing side.

## Testing

- `uv run --group test pytest tests/test_mcp_cards.py` — 401 without a
  Bearer, tool registry, and a full authenticated
  `initialize → tools/list → tools/call` round-trip over Streamable HTTP
  (SSE): list decks, create a card, scope gating (`cards:read` alone
  cannot create), validation errors, OAuth metadata + login page.
- Manual: point MCP Inspector at `http://127.0.0.1:8123/mcp/` with
  Transport Type "Streamable HTTP" and a Google ID token (from a signed-in
  browser session) as the Bearer.

## Deploy

No new infra: `mcp` + `python-jose` ship as main dependencies
(`mcp<2` pinned to the same v1 FastMCP API grimoire locks), and the
existing `scripts/deploy_lightsail.sh` pipeline deploys them with the
service. Before the next deploy, add `SECRET_KEY=<long-random>` to
`.env.prod` (git-ignored; never commit it).
