import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiKeyEnv,
	BETA_HEADER,
	call,
	captureLogs,
	CONSOLE_API_KEY,
	expectNoSecrets,
	makeRequest,
	mockUpstream,
	PROXY_TOKEN,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const baseHeaders = {
	"anthropic-version": "2023-06-01",
	"anthropic-beta": BETA_HEADER,
	"content-type": "application/json",
};

describe("api-key mode", () => {
	it("is the default when AUTH_MODE is unset", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest({ ...baseHeaders, "x-api-key": PROXY_TOKEN }),
			apiKeyEnv({ AUTH_MODE: undefined }),
		);
		expect(response.status).toBe(200);
		expect(upstream.calls[0]!.headers.get("x-api-key")).toBe(CONSOLE_API_KEY);
	});

	it("accepts the proxy token in x-api-key and injects ANTHROPIC_API_KEY", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest({ ...baseHeaders, "x-api-key": PROXY_TOKEN }), apiKeyEnv());
		expect(response.status).toBe(200);
		const sent = upstream.calls[0]!.headers;
		expect(sent.get("x-api-key")).toBe(CONSOLE_API_KEY);
		expect(sent.has("authorization")).toBe(false);
	});

	it("accepts the proxy token as Authorization: Bearer and strips it", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest({ ...baseHeaders, authorization: `Bearer ${PROXY_TOKEN}` }),
			apiKeyEnv(),
		);
		expect(response.status).toBe(200);
		const sent = upstream.calls[0]!.headers;
		expect(sent.has("authorization")).toBe(false);
		expect(sent.get("x-api-key")).toBe(CONSOLE_API_KEY);
	});

	it("rejects a missing proxy token with 401", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest(baseHeaders), apiKeyEnv());
		expect(response.status).toBe(401);
		expect(upstream.calls).toHaveLength(0);
	});

	it("rejects an invalid proxy token with 401", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(makeRequest({ ...baseHeaders, "x-api-key": "not-a-valid-token" }), apiKeyEnv());
		expect(response.status).toBe(401);
		expect(upstream.calls).toHaveLength(0);
	});

	it("fails closed with 500 when ANTHROPIC_API_KEY is missing", async () => {
		captureLogs();
		const upstream = mockUpstream();
		const response = await call(
			makeRequest({ ...baseHeaders, "x-api-key": PROXY_TOKEN }),
			apiKeyEnv({ ANTHROPIC_API_KEY: undefined }),
		);
		expect(response.status).toBe(500);
		expect(upstream.calls).toHaveLength(0);
	});

	it("forwards anthropic-beta verbatim and strips X-Proxy-Token", async () => {
		captureLogs();
		const upstream = mockUpstream();
		await call(makeRequest({ ...baseHeaders, "x-api-key": PROXY_TOKEN, "x-proxy-token": "ignored" }), apiKeyEnv());
		const sent = upstream.calls[0]!.headers;
		expect(sent.get("anthropic-beta")).toBe(BETA_HEADER);
		expect(sent.has("x-proxy-token")).toBe(false);
	});

	it("never logs the proxy token or the Console key", async () => {
		const logs = captureLogs();
		mockUpstream();
		await call(makeRequest({ ...baseHeaders, "x-api-key": PROXY_TOKEN }), apiKeyEnv());
		await call(makeRequest({ ...baseHeaders, "x-api-key": `${PROXY_TOKEN}-wrong` }), apiKeyEnv());
		expectNoSecrets(logs.text());
	});
});
