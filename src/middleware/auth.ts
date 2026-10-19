import type { Config } from "../config";
import { matchesAnyToken } from "../utils/crypto";
import { HttpError } from "../utils/errors";

export const PROXY_TOKEN_HEADER = "x-proxy-token";

export interface AuthResult {
	/** The validated client token; used only as an in-memory rate-limit key. */
	clientToken: string;
}

function bearerToken(authorization: string | null): string | undefined {
	if (!authorization) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
	return match?.[1]?.trim() || undefined;
}

/**
 * api-key mode: the client authenticates with a proxy token in `x-api-key`
 * (ANTHROPIC_API_KEY) or `Authorization: Bearer` (ANTHROPIC_AUTH_TOKEN).
 */
async function authenticateApiKey(request: Request, config: Config): Promise<AuthResult> {
	const token = request.headers.get("x-api-key")?.trim() || bearerToken(request.headers.get("authorization"));
	if (!token) {
		throw new HttpError(401, "authentication_error", "Missing proxy token in x-api-key or Authorization header");
	}
	if (!(await matchesAnyToken(token, config.proxyTokens))) {
		throw new HttpError(401, "authentication_error", "Invalid proxy token");
	}
	return { clientToken: token };
}

/**
 * oauth-passthrough mode: access control uses `X-Proxy-Token` (sent through
 * ANTHROPIC_CUSTOM_HEADERS); the claude.ai OAuth bearer in `Authorization`
 * belongs to the user's subscription and is forwarded untouched.
 */
async function authenticateOAuthPassthrough(request: Request, config: Config): Promise<AuthResult> {
	const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim();
	if (!token) {
		throw new HttpError(
			401,
			"authentication_error",
			"Missing X-Proxy-Token header. Set ANTHROPIC_CUSTOM_HEADERS to \"X-Proxy-Token: <token>\"",
		);
	}
	if (!(await matchesAnyToken(token, config.proxyTokens))) {
		throw new HttpError(401, "authentication_error", "Invalid X-Proxy-Token");
	}

	if (request.headers.has("x-api-key")) {
		throw new HttpError(
			400,
			"invalid_request_error",
			"x-api-key is not accepted in oauth-passthrough mode. Unset ANTHROPIC_API_KEY (and apiKeyHelper) so Claude Code uses your claude.ai login",
		);
	}

	if (!request.headers.get("authorization")?.trim()) {
		throw new HttpError(
			401,
			"authentication_error",
			"Missing Authorization header. Log in with your claude.ai account in the Claude Code extension (/login), and do not set ANTHROPIC_AUTH_TOKEN",
		);
	}

	return { clientToken: token };
}

export async function authenticate(request: Request, config: Config): Promise<AuthResult> {
	return config.authMode === "oauth-passthrough"
		? authenticateOAuthPassthrough(request, config)
		: authenticateApiKey(request, config);
}
