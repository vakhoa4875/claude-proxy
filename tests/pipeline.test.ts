import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/middleware/rate-limit";
import { Redactor } from "../src/utils/logger";
import {
	apiKeyEnv,
	call,
	captureLogs,
	claudeCodeOAuthHeaders,
	makeRequest,
	mockUpstream,
	OAUTH_ACCESS_TOKEN,
	OAUTH_BEARER,
	oauthEnv,
	PROXY_TOKEN,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each([
	["oauth-passthrough", oauthEnv, claudeCodeOAuthHeaders()],
	["api-key", apiKeyEnv, { "x-api-key": PROXY_TOKEN, "anthropic-version": "2023-06-01" }],
] as const)("%s: shared pipeline", (_mode, makeEnv, headers) => {
	it.each(["/v1/messages", "/v1/messages/count_tokens"])("allows POST %s", async (path) => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest({ ...headers }, { path }), makeEnv());
		expect(response.status).toBe(200);
		expect(upstream.calls[0]!.url).toBe(`https://api.anthropic.com${path}`);
	});

	it.each([
		"/v1/models",
		"/v1/complete",
		"/api/hello",
		"/",
		"//v1/messages",
		"/v1/messages/",
		"/v1/messages/batches",
		"/https://evil.example/v1/messages",
	])("rejects %s with 404 without contacting upstream", async (path) => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest({ ...headers }, { path }), makeEnv());
		expect(response.status).toBe(404);
		expect(upstream.calls).toHaveLength(0);
	});

	it.each(["GET", "PUT", "DELETE", "HEAD"])("rejects %s /v1/messages with 405", async (method) => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest({ ...headers }, { method, path: "/v1/messages" }), makeEnv());
		expect(response.status).toBe(405);
		expect(upstream.calls).toHaveLength(0);
	});

	it("always targets api.anthropic.com, whatever Host the client sends", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(makeRequest({ ...headers, host: "evil.example" }), makeEnv());
		expect(new URL(upstream.calls[0]!.url).origin).toBe("https://api.anthropic.com");
		expect(upstream.calls[0]!.headers.has("host")).toBe(false);
	});

	it("drops client-hop headers and adds no location or forwarding headers", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(
			makeRequest({
				...headers,
				cookie: "a=b",
				"cf-connecting-ip": "203.0.113.7",
				"cf-ipcountry": "VN",
				"x-forwarded-for": "203.0.113.7",
				"x-real-ip": "203.0.113.7",
			}),
			makeEnv(),
		);
		const sent = upstream.calls[0]!.headers;
		const names = [...sent.keys()];
		expect(names.filter((name) => name.startsWith("cf-") || name.startsWith("x-forwarded-"))).toEqual([]);
		for (const name of ["cookie", "x-real-ip", "true-client-ip", "forwarded"]) {
			expect(sent.has(name)).toBe(false);
		}
	});

	it("disables caching on the upstream call and in the response", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest({ ...headers }), makeEnv());
		expect(upstream.calls[0]!.init.cache).toBe("no-store");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("streams SSE incrementally without buffering", async () => {
		captureLogs();
		const encoder = new TextEncoder();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		mockUpstream(
			() => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const response = await call(makeRequest({ ...headers }), makeEnv());
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		// The upstream has not finished (or even sent anything) yet, but the
		// Worker has already returned its response.
		controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
		const first = await reader.read();
		expect(decoder.decode(first.value)).toContain("message_start");

		controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
		const second = await reader.read();
		expect(decoder.decode(second.value)).toContain("ping");

		controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
		controller.close();
		const third = await reader.read();
		expect(decoder.decode(third.value)).toContain("message_stop");
		expect((await reader.read()).done).toBe(true);
	});

	it("passes the client's abort signal upstream and cancels on disconnect", async () => {
		captureLogs();
		const client = new AbortController();
		let upstreamSignal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			upstreamSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				upstreamSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		});

		const pending = call(makeRequest({ ...headers }, { signal: client.signal }), makeEnv());
		await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
		expect(upstreamSignal!.aborted).toBe(false);

		client.abort();
		const response = await pending;
		expect(upstreamSignal!.aborted).toBe(true);
		expect(response.status).toBe(499);
	});

	it("rate limits per client token and returns integer retry-after", async () => {
		captureLogs();
		const upstream = mockUpstream();
		let now = 1_000_000;
		const limiter = new RateLimiter(() => now);
		const env = makeEnv({ RATE_LIMIT_PER_MINUTE: "2" });

		expect((await call(makeRequest({ ...headers }), env, limiter)).status).toBe(200);
		expect((await call(makeRequest({ ...headers }), env, limiter)).status).toBe(200);
		const limited = await call(makeRequest({ ...headers }), env, limiter);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
		expect(upstream.calls).toHaveLength(2);

		now += 60_000;
		expect((await call(makeRequest({ ...headers }), env, limiter)).status).toBe(200);
	});

	it("logs one structured line per request with no header values", async () => {
		const logs = captureLogs();
		mockUpstream();
		await call(makeRequest({ ...headers }), makeEnv());
		const records = logs.json();
		expect(records).toHaveLength(1);
		expect(Object.keys(records[0]!).sort()).toEqual(
			["auth_mode", "duration_ms", "event", "method", "outcome", "path", "request_id", "status", "upstream_status"].sort(),
		);
	});
});

describe("CORS", () => {
	it("refuses browser origins that are not allowed", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest(claudeCodeOAuthHeaders({ origin: "https://evil.example" })),
			oauthEnv(),
		);
		expect(response.status).toBe(403);
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		expect(upstream.calls).toHaveLength(0);
	});

	it("answers preflight for an allowed origin", async () => {
		captureLogs();
		const response = await call(
			makeRequest(
				{ origin: "https://app.example", "access-control-request-headers": "x-proxy-token, content-type" },
				{ method: "OPTIONS", body: null },
			),
			oauthEnv({ ALLOWED_ORIGINS: "https://app.example" }),
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
	});

	it("adds CORS headers for an allowed origin and keeps upstream headers", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest(claudeCodeOAuthHeaders({ origin: "https://app.example" })),
			oauthEnv({ ALLOWED_ORIGINS: "https://app.example" }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
		expect(response.headers.get("request-id")).toBe("req_test_123");
		expect(upstream.calls[0]!.headers.has("origin")).toBe(false);
	});

	it("sends no CORS headers to non-browser clients", async () => {
		captureLogs();
		mockUpstream();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv());
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
	});
});

describe("configuration", () => {
	it("rejects an unknown AUTH_MODE with 500 and does not contact upstream", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv({ AUTH_MODE: "both" }));
		expect(response.status).toBe(500);
		expect(upstream.calls).toHaveLength(0);
	});

	it("fails closed when PROXY_TOKENS is empty", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest(claudeCodeOAuthHeaders()), oauthEnv({ PROXY_TOKENS: " , " }));
		expect(response.status).toBe(500);
		expect(upstream.calls).toHaveLength(0);
	});
});

describe("Redactor", () => {
	it("removes registered secrets and generic credential patterns", () => {
		const redactor = new Redactor();
		redactor.add(OAUTH_BEARER);
		const out = redactor.redact(
			`a ${OAUTH_BEARER} b ${OAUTH_ACCESS_TOKEN} c Bearer other-token d sk-ant-api03-xyz e`,
		);
		expect(out).not.toContain(OAUTH_ACCESS_TOKEN);
		expect(out).not.toContain("other-token");
		expect(out).not.toContain("sk-ant-api03-xyz");
		expect(out).toContain("[REDACTED]");
	});
});
