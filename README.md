# claude-proxy

A small Cloudflare Worker that sits between Claude Code and the Anthropic Messages API. It is built for **one person's own use**.

It has two auth modes, chosen with `AUTH_MODE`:

| Mode | What the client sends | What the Worker sends to Anthropic | Billed to |
| --- | --- | --- | --- |
| `api-key` (code default) | Proxy token in `x-api-key` or `Authorization: Bearer` | Proxy token removed; `x-api-key: $ANTHROPIC_API_KEY` from Worker Secrets | The Console account that owns `ANTHROPIC_API_KEY` |
| `oauth-passthrough` (set in `wrangler.toml`) | Proxy token in `X-Proxy-Token`; claude.ai OAuth bearer in `Authorization` | `X-Proxy-Token` removed; `Authorization` forwarded **unchanged** | Your claude.ai subscription (see [Compatibility](#compatibility)) |

Both modes share the same pipeline:

- Fixed upstream `https://api.anthropic.com`. Only `POST /v1/messages` and `POST /v1/messages/count_tokens` are forwarded; every other path gets `404` and every other method gets `405`.
- The client's query string is kept (`/v1/messages?beta=true`).
- Request headers are forwarded as an open list: all `anthropic-*` and `x-claude-code-*` headers go through verbatim. Dropped headers: hop-by-hop headers, `host`, `cookie`, `origin`, `referer`, Cloudflare edge metadata (`cf-*`, `x-forwarded-*`, `x-real-ip`, `true-client-ip`, `forwarded`) and the proxy credential. Nothing is added in their place.
- The request body is streamed upstream unchanged.
- Upstream responses come back without buffering, so SSE events (including `ping`) reach Claude Code as they arrive.
  - All upstream response headers are returned unchanged.
  - Error bodies are returned unmodified.
- When the client disconnects, the upstream request is cancelled (`request.signal` with the `enable_request_signal` compatibility flag).
- Nothing is cached: the upstream fetch uses `cache: "no-store"`, the Worker never uses the Cache API, KV or D1, and responses get `cache-control: no-store` if upstream set none.
- Rate limiting is a per-isolate, in-memory fixed window keyed by a truncated hash of the proxy token (`RATE_LIMIT_PER_MINUTE`, default 120, `0` disables).
  - This is a best-effort guard against runaway loops, not a global quota.
  - A `429` from the Worker carries an integer `retry-after`.
- CORS: browser requests (those with an `Origin` header) get `403` unless the origin is listed in `ALLOWED_ORIGINS`, which is empty by default. Claude Code sends no `Origin`.
- Logs are redacted. See [What gets logged](#what-gets-logged).

## Layout

```
src/
  index.ts                     request pipeline: config → CORS → route → auth → rate limit → proxy → log
  config.ts                    AUTH_MODE / PROXY_TOKENS / ANTHROPIC_API_KEY / RATE_LIMIT_PER_MINUTE / ALLOWED_ORIGINS
  middleware/auth.ts           api-key and oauth-passthrough authentication
  middleware/cors.ts           origin check and preflight
  middleware/rate-limit.ts     in-memory limiter
  middleware/route.ts          upstream path allowlist
  services/anthropic-proxy.ts  header rewriting, streaming forward
  utils/crypto.ts              SHA-256 + constant-time token comparison
  utils/logger.ts              structured, redacted request log
  utils/errors.ts              Anthropic-shaped error responses
tests/                         vitest + @cloudflare/vitest-plugin (Workers runtime, mocked upstream)
```

## Development

```bash
npm install
npm run check     # typecheck + lint + tests
npm run dry-run   # wrangler deploy --dry-run --outdir dist
npm run dev       # local dev; copy .dev.vars.example to .dev.vars first
```

The tests run inside the Workers runtime with global `fetch` mocked, so they never contact Anthropic.

## api-key mode

Set `AUTH_MODE = "api-key"` in `wrangler.toml` (or remove the line, since `api-key` is the default), then:

```bash
npx wrangler secret put PROXY_TOKENS        # one or more comma-separated client tokens
npx wrangler secret put ANTHROPIC_API_KEY   # your Anthropic Console key
npm run deploy
```

Claude Code side:

```bash
export ANTHROPIC_BASE_URL=https://claude-proxy.<subdomain>.workers.dev
export ANTHROPIC_AUTH_TOKEN=<proxy token>   # or ANTHROPIC_API_KEY=<proxy token>
```

## OAuth passthrough (personal subscription)

Goal: the official Claude Code extension in VS Code (or Kiro) stays signed in with **your own claude.ai account**, its model requests go through your Worker, and usage counts against your subscription. No API key is involved.

### Why this works (docs basis)

These quotes are from the Claude Code docs, as read on 2026-10-19:

- [LLM gateway → Subscriptions and gateways](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways):
  > "Setting only that variable, without a gateway credential, doesn't replace the subscription. Requests still route through the gateway, but a saved claude.ai login remains the active credential, so its usage limits and billing apply. Gateways that pass this traffic on to Anthropic must forward the OAuth capability in `anthropic-beta`"
- [Gateway protocol → Request headers](https://code.claude.com/docs/en/llm-gateway-protocol#request-headers):
  > "`anthropic-beta` … Forward the header verbatim; don't allowlist individual values … When the developer authenticates with a claude.ai login, which is possible when `ANTHROPIC_BASE_URL` is set without a gateway credential variable, this header also carries an OAuth capability that the upstream requires, and stripping it fails those requests with `401`"
- [Gateway protocol → Response headers](https://code.claude.com/docs/en/llm-gateway-protocol#response-headers):
  > "`anthropic-ratelimit-unified-*` — Forward the upstream's values unchanged on every response. Claude Code reads them on successful responses to show usage against plan limits to developers signed in with claude.ai"
- [Gateway protocol → Streaming](https://code.claude.com/docs/en/llm-gateway-protocol#streaming):
  > "If your gateway buffers a response until it is complete, Claude Code stalls."
- [Connect → Send additional headers](https://code.claude.com/docs/en/llm-gateway-connect#send-additional-headers): `ANTHROPIC_CUSTOM_HEADERS` takes "one `Name: Value` pair per line".
- [Connect → Conflicts with an existing login](https://code.claude.com/docs/en/llm-gateway-connect#conflicts-with-an-existing-login):
  > "A gateway credential variable takes precedence over a saved claude.ai login or Console key."

  This is why `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` must stay unset.
- [VS Code](https://code.claude.com/docs/en/vs-code):
  > "the extension also installs in forks like Devin Desktop or Kiro"

  The docs say nothing about gateway or subscription behavior in Kiro, so **Kiro support is unverified**.

### 1. Worker setup

Generate a long random token for `X-Proxy-Token`.

bash:

```bash
openssl rand -hex 32
```

Windows PowerShell (5.1 or 7):

```powershell
$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

Configure and deploy:

```bash
npx wrangler login
npx wrangler secret put PROXY_TOKENS     # paste the token
# AUTH_MODE is already "oauth-passthrough" in wrangler.toml ([vars]).
# ANTHROPIC_API_KEY is not needed in this mode; it is ignored even if set.
npm run deploy
```

`PROXY_TOKENS` accepts a comma-separated list, so you can rotate without downtime: put `new,old`, switch your editor to `new`, then set `PROXY_TOKENS` to just `new`.

Smoke test without any OAuth token. You should get `401` with the message "Missing Authorization header. Log in with your claude.ai account…". That proves the Worker is deployed and accepts your `X-Proxy-Token`:

```bash
curl -sS -w '\n%{http_code}\n' -X POST https://claude-proxy.<subdomain>.workers.dev/v1/messages \
  -H "X-Proxy-Token: <token>" -H "content-type: application/json" -d '{}'
```

```powershell
curl.exe -sS -w "`n%{http_code}`n" -X POST https://claude-proxy.<subdomain>.workers.dev/v1/messages -H "X-Proxy-Token: <token>" -H "content-type: application/json" -d "{}"
```

### 2. Editor settings (same for VS Code and Kiro)

Open the user settings JSON with `Ctrl+Shift+P` → **Preferences: Open User Settings (JSON)**, or open the file directly:

- VS Code: `%APPDATA%\Code\User\settings.json`
- Kiro: `%APPDATA%\Kiro\User\settings.json`

Add:

```json
"claudeCode.environmentVariables": [
  { "name": "ANTHROPIC_BASE_URL", "value": "https://claude-proxy.<subdomain>.workers.dev" },
  { "name": "ANTHROPIC_CUSTOM_HEADERS", "value": "X-Proxy-Token: <token>" }
]
```

Then reload the window (`Ctrl+Shift+P` → **Developer: Reload Window**) and sign in to the extension with your claude.ai account if it asks.

> [!WARNING]
> Do **not** set `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, either here, in `~/.claude/settings.json` (`env` block), or in your shell or system environment. Also don't configure an `apiKeyHelper`. Any of them **replaces the claude.ai login**, and the Worker answers `400` (`x-api-key`) or forwards the wrong credential. Leave `claudeCode.disableLoginPrompt` at `false`.

> [!NOTE]
> The settings file now contains your proxy token. Don't commit it or sync it to a shared machine.

> [!NOTE]
> **Kiro:** only the Claude Code extension goes through claude-proxy. Kiro's own built-in AI features use Kiro's backend and are not affected by these settings.

### 3. What goes through the Worker and what bypasses it

| Traffic | Path | Source |
| --- | --- | --- |
| Model requests (`POST /v1/messages?beta=true`) | **Through the Worker** | documented |
| Token counting (`POST /v1/messages/count_tokens`) | **Through the Worker** | documented (optional endpoint) |
| `HEAD /api/hello` connection-warming probe | Reaches the Worker, gets `404`; harmless | documented ("can reject without breaking anything") |
| Model discovery `GET /v1/models` | Only if `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (off by default); Worker returns `404`, picker falls back to built-in list | documented |
| claude.ai login and OAuth token refresh | Bypasses the Worker (goes to Anthropic's auth endpoints directly) | **assumption**: the docs don't say where login/refresh traffic goes |
| Telemetry | Bypasses the Worker, sent to Anthropic | documented |
| Fast-mode availability check | Bypasses the Worker, calls `api.anthropic.com` directly | documented |
| WebFetch domain safety check | Bypasses the Worker, calls `api.anthropic.com` directly | documented |
| Version checks, auto-update, release notes | Bypass the Worker | documented ("nonessential traffic") |
| Plan-usage display | Read from `anthropic-ratelimit-unified-*` on responses that go through the Worker | documented; whether any usage screen *also* calls Anthropic directly is an **assumption** |
| Any other Anthropic API path Claude Code may call via the base URL | Rejected with `404` by the path allowlist | **assumption** that nothing essential uses another path; `wrangler tail` shows `outcome: "rejected"` with the path if it happens |

### 4. Features that stop working or change

- **Remote Control**: disabled. "Remote Control is also disabled while `ANTHROPIC_BASE_URL` points at a non-Anthropic host, so signing in with claude.ai isn't enough on its own." (documented)
- **HIPAA configuration**: not eligible through a gateway. (documented)
- **Fine-grained tool streaming**: off by default behind a custom base URL; opt in with `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`. (documented)
- **Gateway model discovery, Message Batches, Files, Models endpoints**: not served (`404`) by design.
- **Cloud sessions and Claude in Slack**: never use your editor's gateway settings. (documented)
- **Voice dictation**: the docs only say it is unavailable while a gateway *credential* is active. With only a base URL set it should still work, but this is **unverified**.

### 5. Manual integration test checklist

Run this **separately in VS Code and in Kiro**. Keep `npx wrangler tail` open in a terminal while you test.

| # | Check | VS Code | Kiro |
| --- | --- | --- | --- |
| 1 | `/status` shows a **Login method** line naming your claude.ai account **and** an **Anthropic base URL** line with your Worker URL, and **no** `Auth token` / `API key` line | ☐ | ☐ |
| 2 | A short prompt succeeds, and `npx wrangler tail` shows `"path":"/v1/messages","status":200,"auth_mode":"oauth-passthrough"` | ☐ | ☐ |
| 3 | Streaming works: a long answer appears progressively, not all at once | ☐ | ☐ |
| 4 | Plan usage still displays (for example `/usage`, or the usage indicator in the extension) | ☐ | ☐ |
| 5 | Long session: keep a session going for more than one hour (past an OAuth access-token refresh), and prompts still succeed without re-login. A `401` from upstream in `wrangler tail` would point to a refresh problem | ☐ | ☐ |
| 6 | Negative test: temporarily change the token in `ANTHROPIC_CUSTOM_HEADERS`, reload, and send a prompt. Expect an error mentioning `X-Proxy-Token`; `wrangler tail` shows `status: 401, outcome: "rejected"` | ☐ | ☐ |

Also confirm in your claude.ai account's usage page that the usage shows up there, and **not** in any Anthropic Console account.

### 6. Compatibility

Rows stay in the "Unverified" column until you report back from the manual checklist.

| Item | Confirmed by docs | Confirmed by unit tests | Unverified — needs my manual test |
| --- | :---: | :---: | :---: |
| Base URL only (no credential var) keeps the claude.ai login active | ✅ | | |
| `anthropic-beta` must be forwarded verbatim (OAuth capability) | ✅ | ✅ | |
| `anthropic-ratelimit-unified-*`, `retry-after`, `x-should-retry` returned unchanged | ✅ | ✅ | |
| SSE must not be buffered | ✅ | ✅ (incremental read test) | |
| `ANTHROPIC_CUSTOM_HEADERS` delivers `X-Proxy-Token` | ✅ | | |
| Valid / missing / invalid `X-Proxy-Token` → forward / `401` / `401`, no upstream call on reject | | ✅ | |
| `X-Proxy-Token` stripped before forwarding | | ✅ | |
| `Authorization` forwarded byte-for-byte; missing → `401` with claude.ai hint | | ✅ | |
| `ANTHROPIC_API_KEY` neither required nor injected | | ✅ | |
| `x-api-key` rejected with `400` | | ✅ | |
| OAuth bearer, proxy token and Console key absent from all logs (success, reject, misconfig, network error, upstream error, rate limit) | | ✅ | |
| Client disconnect cancels the upstream request | | ✅ | |
| Path allowlist, `405` on other methods, fixed upstream origin | | ✅ | |
| api-key mode unchanged behavior | | ✅ | |
| Claude Code extension installs in Kiro | ✅ | | |
| VS Code end-to-end (login + prompt + streaming through the Worker) | | | ⚠️ |
| Kiro end-to-end | | | ⚠️ |
| Extension login stays claude.ai with these settings | | | ⚠️ |
| Usage is billed to the subscription (not to an API account) | | | ⚠️ |
| Plan-usage display through the Worker | | | ⚠️ |
| Behavior across an OAuth token refresh in a long session | | | ⚠️ |
| Login/refresh traffic bypasses the Worker | | | ⚠️ |

### 7. Security notes

- **The Worker sees your claude.ai OAuth access token in transit.** Anyone who can deploy code to this Worker, or read its traffic, could capture it. Therefore:
  - Enable **2FA** on your Cloudflare account and keep its recovery codes safe.
  - Restrict who can deploy. Don't add other members to the Cloudflare account, and use scoped API tokens for CI, if any.
  - Don't add logging, `tail` consumers, Logpush or observability exports that capture request headers. The Worker itself logs no headers and redacts known secrets from error text.
- The token is never stored, cached, persisted, hashed-to-storage or echoed. There is no KV, D1, Durable Object or Cache API usage, and the code never reads local credential files or keychains and never mints or refreshes OAuth tokens.
- **Rotate `X-Proxy-Token`** if it leaks (for example a settings file was shared):
  1. `npx wrangler secret put PROXY_TOKENS` with a new value.
  2. Update `ANTHROPIC_CUSTOM_HEADERS`.
  3. Reload the editor.

  If you think your OAuth token leaked, sign out of all claude.ai sessions and log in again.
- **Personal use only.** Don't hand `X-Proxy-Token` to anyone else, and don't use this Worker to let other people use your subscription. Your subscription's terms and usage policies apply unchanged.
- The Worker adds nothing meant to change where a request appears to come from. Anthropic's supported-regions and usage policies apply to you exactly as they would without the Worker. Don't use it to get around them.

## What gets logged

One JSON line per request (visible with `npx wrangler tail`):

```json
{"event":"request","request_id":"<cf-ray>","auth_mode":"oauth-passthrough","method":"POST","path":"/v1/messages","status":200,"duration_ms":412,"outcome":"ok","upstream_status":200}
```

- No header values and no request or response bodies are logged.
- When Anthropic answers with a non-2xx status, `upstream_error` holds the error's `type: message` (or the page title for an HTML error page), redacted and cut to 300 characters. The error body itself is still returned to the client unchanged.
- On errors, an `error` field holds `ErrorName: message`, scrubbed of every credential seen on that request, plus any `Bearer …` or `sk-ant-…` pattern.
- `observability` is disabled in `wrangler.toml`.
