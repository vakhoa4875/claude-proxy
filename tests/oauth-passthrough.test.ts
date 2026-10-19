import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
	BETA_HEADER,
	call,
	captureLogs,
	claudeCodeOAuthHeaders,
	CONSOLE_API_KEY,
	expectNoSecrets,
	makeRequest,
	MESSAGE_BODY,
	mockUpstream,
	OAUTH_ACCESS_TOKEN,
	OAUTH_BEARER,
	oauthEnv,
	okJson,
	OTHER_PROXY_TOKEN,
	PROXY_TOKEN,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("oauth-passthrough: X-Proxy-Token access control", () => {
	it("accepts a valid X-Proxy-Token and forwards to Anthropic", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(response.status).toBe(200);
		expect(upstream.calls).toHaveLength(1);
		expect(upstream.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
	});

	it("accepts any token in PROXY_TOKENS (rotation)", async () => {
		captureLogs();
		mockUpstream();
		const response = await call(
			makeRequest(claudeCodeOAuthHeaders({ "x-proxy-token": OTHER_PROXY_TOKEN })),
			oauthEnv(),
		);
		expect(response.status).toBe(200);
	});

	it("rejects a missing X-Proxy-Token with 401 before contacting Anthropic", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const headers = claudeCodeOAuthHeaders();
		delete headers["x-proxy-token"];
		const response = await call(makeRequest(headers), oauthEnv());
		expect(response.status).toBe(401);
		const body = await response.json<{ error: { type: string; message: string } }>();
		expect(body.error.type).toBe("authentication_error");
		expect(body.error.message).toContain("X-Proxy-Token");
		expect(upstream.calls).toHaveLength(0);
	});

	it("rejects an invalid X-Proxy-Token with 401 before contacting Anthropic", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest(claudeCodeOAuthHeaders({ "x-proxy-token": `${PROXY_TOKEN}x` })),
			oauthEnv(),
		);
		expect(response.status).toBe(401);
		expect(upstream.calls).toHaveLength(0);
	});

	it("does not accept the proxy token in Authorization instead of X-Proxy-Token", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest({ authorization: `Bearer ${PROXY_TOKEN}`, "anthropic-version": "2023-06-01" }),
			oauthEnv(),
		);
		expect(response.status).toBe(401);
		expect(upstream.calls).toHaveLength(0);
	});

	it("strips X-Proxy-Token before forwarding", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		const sent = upstream.calls[0]!.headers;
		expect(sent.has("x-proxy-token")).toBe(false);
		for (const [, value] of sent) expect(value).not.toContain(PROXY_TOKEN);
	});
});

describe("oauth-passthrough: Authorization handling", () => {
	it("forwards Authorization byte-for-byte", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(upstream.calls[0]!.headers.get("authorization")).toBe(OAUTH_BEARER);
	});

	it("rejects a missing Authorization with 401 telling the user to log in with claude.ai", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const headers = claudeCodeOAuthHeaders();
		delete headers.authorization;
		const response = await call(makeRequest(headers), oauthEnv());
		expect(response.status).toBe(401);
		const body = await response.json<{ error: { message: string } }>();
		expect(body.error.message).toMatch(/claude\.ai/);
		expect(upstream.calls).toHaveLength(0);
	});

	it("does not require ANTHROPIC_API_KEY", async () => {
		captureLogs();
		mockUpstream();
		const env = oauthEnv();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), env);
		expect(response.status).toBe(200);
	});

	it("never injects ANTHROPIC_API_KEY, even when the secret is set", async () => {
		const logs = captureLogs();
		const upstream = mockUpstream();
		await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv({ ANTHROPIC_API_KEY: CONSOLE_API_KEY }));
		const sent = upstream.calls[0]!.headers;
		expect(sent.has("x-api-key")).toBe(false);
		expect(sent.get("authorization")).toBe(OAUTH_BEARER);
		for (const [, value] of sent) expect(value).not.toContain(CONSOLE_API_KEY);
		expectNoSecrets(logs.text());
	});

	it("rejects x-api-key with a clear 400 before contacting Anthropic", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest(claudeCodeOAuthHeaders({ "x-api-key": CONSOLE_API_KEY })),
			oauthEnv(),
		);
		expect(response.status).toBe(400);
		const body = await response.json<{ error: { type: string; message: string } }>();
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain("x-api-key");
		expect(body.error.message).toContain("ANTHROPIC_API_KEY");
		expect(upstream.calls).toHaveLength(0);
	});
});

describe("oauth-passthrough: header and body pass-through", () => {
	it("forwards anthropic-beta verbatim", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(upstream.calls[0]!.headers.get("anthropic-beta")).toBe(BETA_HEADER);
	});

	it("forwards other anthropic-* and x-claude-code-* headers and the body unchanged", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(
			makeRequest(claudeCodeOAuthHeaders({ "anthropic-future-header": "v1", "x-claude-code-agent-id": "agent-1" })),
			oauthEnv(),
		);
		const sent = upstream.calls[0]!;
		expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(sent.headers.get("anthropic-future-header")).toBe("v1");
		expect(sent.headers.get("x-claude-code-session-id")).toBe("3d1c6c3e-6f0e-4d7a-9a63-2f5b9c0d1e2f");
		expect(sent.headers.get("x-claude-code-agent-id")).toBe("agent-1");
		expect(sent.body).toBe(MESSAGE_BODY);
	});

	it("returns anthropic-ratelimit-unified-*, retry-after and x-should-retry unchanged", async () => {
		captureLogs();
		const upstreamHeaders = {
			"anthropic-ratelimit-unified-status": "allowed_warning",
			"anthropic-ratelimit-unified-5h-utilization": "0.87",
			"anthropic-ratelimit-unified-7d-reset": "1760000000",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"retry-after": "17",
			"x-should-retry": "true",
		};
		mockUpstream(() => okJson(upstreamHeaders, 429));
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(response.status).toBe(429);
		for (const [name, value] of Object.entries(upstreamHeaders)) {
			expect(response.headers.get(name)).toBe(value);
		}
		expect(response.headers.get("request-id")).toBe("req_test_123");
	});

	it("returns upstream 401 bodies unmodified (capability-rejection recovery)", async () => {
		captureLogs();
		const upstreamBody = JSON.stringify({
			type: "error",
			error: { type: "authentication_error", message: "OAuth token has expired." },
		});
		mockUpstream(() => new Response(upstreamBody, { status: 401, headers: { "content-type": "application/json" } }));
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(upstreamBody);
	});
});

describe("oauth-passthrough: the OAuth bearer never appears in logs", () => {
	it("success path", async () => {
		const logs = captureLogs();
		mockUpstream();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		await response.text();
		expect(logs.lines.length).toBeGreaterThan(0);
		expectNoSecrets(logs.text());
	});

	it.each([
		["invalid X-Proxy-Token", claudeCodeOAuthHeaders({ "x-proxy-token": "wrong-token-value" })],
		["x-api-key present", claudeCodeOAuthHeaders({ "x-api-key": CONSOLE_API_KEY })],
	])("rejection path: %s", async (_name, headers) => {
		const logs = captureLogs();
		mockUpstream();
		const response = await call(makeRequest(headers), oauthEnv());
		expect(response.status).toBeGreaterThanOrEqual(400);
		expectNoSecrets(logs.text());
		expectNoSecrets(await response.text());
	});

	it("misconfiguration path (PROXY_TOKENS unset)", async () => {
		const logs = captureLogs();
		mockUpstream();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv({ PROXY_TOKENS: "" }));
		expect(response.status).toBe(500);
		expectNoSecrets(logs.text());
		expectNoSecrets(await response.text());
	});

	it("upstream network error whose message contains the bearer", async () => {
		const logs = captureLogs();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError(
				`connect failed while sending authorization: ${OAUTH_BEARER} (token ${OAUTH_ACCESS_TOKEN}, proxy ${PROXY_TOKEN})`,
			),
		);
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(response.status).toBe(502);
		const log = logs.json().at(-1)!;
		expect(log.outcome).toBe("gateway_error");
		expect(String(log.error)).toContain("[REDACTED]");
		expectNoSecrets(logs.text());
		expectNoSecrets(await response.text());
	});

	it("upstream error response", async () => {
		const logs = captureLogs();
		mockUpstream(() => new Response("upstream exploded", { status: 500 }));
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(response.status).toBe(500);
		await response.text();
		expectNoSecrets(logs.text());
	});

	it("rate-limit path", async () => {
		const logs = captureLogs();
		mockUpstream();
		const { RateLimiter } = await import("../src/middleware/rate-limit");
		const limiter = new RateLimiter();
		const env = oauthEnv({ RATE_LIMIT_PER_MINUTE: "1" });
		await call(makeRequest(claudeCodeOAuthHeaders()), env, limiter);
		const limited = await call(makeRequest(claudeCodeOAuthHeaders()), env, limiter);
		expect(limited.status).toBe(429);
		expectNoSecrets(logs.text());
		expectNoSecrets(await limited.text());
	});
});

describe("oauth-passthrough: deployed entrypoint", () => {
	it("the default export routes through the same pipeline", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await worker.fetch(
			makeRequest(claudeCodeOAuthHeaders()) as Request<unknown, IncomingRequestCfProperties>,
			oauthEnv(),
		);
		expect(response.status).toBe(200);
		expect(upstream.calls[0]!.headers.get("authorization")).toBe(OAUTH_BEARER);
	});
});
