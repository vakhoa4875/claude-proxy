import { vi } from "vitest";
import type { Env } from "../src/config";
import { handleRequest } from "../src/index";
import { RateLimiter } from "../src/middleware/rate-limit";

export const WORKER_URL = "https://claude-proxy.example.workers.dev";

/** Fake values only. Long and distinctive so leaks are easy to grep for. */
export const PROXY_TOKEN = "cgw_test_proxy_token_7f3a9c1e5b2d4f6a8c0e";
export const OTHER_PROXY_TOKEN = "cgw_test_rotated_token_1b2c3d4e5f6a7b8c9d0e";
export const OAUTH_ACCESS_TOKEN = "sk-ant-oat01-FAKE-test-only-Zq8Lm2Nx4Vb6Cd8Ef0Gh2Ij4Kl6Mn8";
export const OAUTH_BEARER = `Bearer ${OAUTH_ACCESS_TOKEN}`;
export const CONSOLE_API_KEY = "sk-ant-api03-FAKE-console-key-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8";

export const SECRETS = [PROXY_TOKEN, OTHER_PROXY_TOKEN, OAUTH_ACCESS_TOKEN, CONSOLE_API_KEY];

export const BETA_HEADER =
	"oauth-2025-04-20,interleaved-thinking-2025-05-14, context-management-2025-06-27,future-capability-2099-12-31";

export const MESSAGE_BODY = JSON.stringify({
	model: "claude-sonnet-4-6",
	max_tokens: 16,
	stream: true,
	messages: [{ role: "user", content: "hi" }],
});

export function oauthEnv(overrides: Partial<Env> = {}): Env {
	return {
		AUTH_MODE: "oauth-passthrough",
		PROXY_TOKENS: `${PROXY_TOKEN},${OTHER_PROXY_TOKEN}`,
		RATE_LIMIT_PER_MINUTE: "0",
		...overrides,
	};
}

export function apiKeyEnv(overrides: Partial<Env> = {}): Env {
	return {
		AUTH_MODE: "api-key",
		PROXY_TOKENS: PROXY_TOKEN,
		ANTHROPIC_API_KEY: CONSOLE_API_KEY,
		RATE_LIMIT_PER_MINUTE: "0",
		...overrides,
	};
}

/** Headers Claude Code sends when signed in with claude.ai behind ANTHROPIC_BASE_URL. */
export function claudeCodeOAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		authorization: OAUTH_BEARER,
		"x-proxy-token": PROXY_TOKEN,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": BETA_HEADER,
		"content-type": "application/json",
		"x-claude-code-session-id": "3d1c6c3e-6f0e-4d7a-9a63-2f5b9c0d1e2f",
		...extra,
	};
}

export function makeRequest(
	headers: Record<string, string>,
	{ path = "/v1/messages?beta=true", method = "POST", body = MESSAGE_BODY, signal }: {
		path?: string;
		method?: string;
		body?: string | null;
		signal?: AbortSignal;
	} = {},
): Request {
	return new Request(`${WORKER_URL}${path}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? null : body,
		signal,
	});
}

export interface UpstreamCall {
	url: string;
	headers: Headers;
	body: string;
	init: RequestInit;
}

/**
 * Replaces global fetch (the Worker's only way out) with a mock. No request
 * ever leaves the test runtime.
 */
export function mockUpstream(respond: (call: UpstreamCall) => Response | Promise<Response> = () => okJson()) {
	const calls: UpstreamCall[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init.body ? await new Response(init.body as BodyInit).text() : "";
		const call = { url, headers: new Headers(init.headers), body, init };
		calls.push(call);
		return respond(call);
	});
	return { calls, spy };
}

export function okJson(headers: Record<string, string> = {}, status = 200): Response {
	return new Response(JSON.stringify({ id: "msg_test", type: "message", content: [] }), {
		status,
		headers: { "content-type": "application/json", "request-id": "req_test_123", ...headers },
	});
}

/** Captures every console method so tests can assert on all log output. */
export function captureLogs() {
	const lines: string[] = [];
	const record = (...args: unknown[]) => {
		lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
	};
	for (const method of ["log", "error", "warn", "info", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation(record);
	}
	return {
		lines,
		text: () => lines.join("\n"),
		json: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
	};
}

export function expectNoSecrets(text: string, secrets: readonly string[] = SECRETS): void {
	for (const secret of secrets) {
		if (text.includes(secret)) {
			throw new Error(`secret leaked: ${secret.slice(0, 12)}…`);
		}
	}
	if (/Bearer\s+\S/i.test(text)) throw new Error("a Bearer credential appears in the output");
	if (text.includes("oat01")) throw new Error("an OAuth token fragment appears in the output");
}

export function call(request: Request, env: Env, limiter = new RateLimiter()): Promise<Response> {
	return handleRequest(request, env, limiter);
}
