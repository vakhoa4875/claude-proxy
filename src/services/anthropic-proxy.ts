import type { Config } from "../config";
import { PROXY_TOKEN_HEADER } from "../middleware/auth";

export const UPSTREAM_ORIGIN = "https://api.anthropic.com";

/** Hop-by-hop headers (RFC 9110 §7.6.1) plus ones the runtime recomputes. */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);

/**
 * Headers that belong to the client↔Worker hop and are not part of the
 * Anthropic request: browser context, cookies, and Cloudflare edge metadata.
 * Nothing is added in their place.
 */
const CLIENT_HOP_ONLY = new Set([
	"cookie",
	"origin",
	"referer",
	"forwarded",
	"x-real-ip",
	"true-client-ip",
	"cdn-loop",
	PROXY_TOKEN_HEADER,
]);

function isDropped(name: string): boolean {
	return (
		HOP_BY_HOP.has(name) ||
		CLIENT_HOP_ONLY.has(name) ||
		name.startsWith("cf-") ||
		name.startsWith("x-forwarded-")
	);
}

/**
 * Builds upstream headers. Everything else, including every `anthropic-*` and
 * `x-claude-code-*` header, is forwarded byte-for-byte (open list, per the
 * Claude Code gateway compatibility guide).
 */
export function buildUpstreamHeaders(incoming: Headers, config: Config): Headers {
	const headers = new Headers();
	for (const [name, value] of incoming) {
		if (!isDropped(name)) headers.set(name, value);
	}

	if (config.authMode === "api-key") {
		// The client's proxy token must never reach Anthropic.
		headers.delete("authorization");
		headers.set("x-api-key", config.anthropicApiKey ?? "");
	}
	// oauth-passthrough: Authorization was copied verbatim above; auth already
	// rejected x-api-key, and no Worker credential is added.

	return headers;
}

export function upstreamUrl(url: URL): string {
	// Only the pathname (already checked against the allowlist) and query are
	// taken from the client; the origin is fixed.
	return `${UPSTREAM_ORIGIN}${url.pathname}${url.search}`;
}

/**
 * Forwards the request and returns the upstream response without buffering:
 * the body stream is handed straight back so SSE events (including `ping`)
 * reach Claude Code as they arrive. `request.signal` cancels the upstream call
 * when the client disconnects.
 */
export async function proxyToAnthropic(request: Request, url: URL, config: Config): Promise<Response> {
	const upstream = await fetch(upstreamUrl(url), {
		method: "POST",
		headers: buildUpstreamHeaders(request.headers, config),
		body: request.body,
		signal: request.signal,
		cache: "no-store",
		redirect: "manual",
	});

	// All upstream headers are returned unchanged, including
	// anthropic-ratelimit-unified-*, retry-after, x-should-retry and request-id.
	const headers = new Headers(upstream.headers);
	if (!headers.has("cache-control")) headers.set("cache-control", "no-store");

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}
