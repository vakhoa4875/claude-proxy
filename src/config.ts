export type AuthMode = "api-key" | "oauth-passthrough";

export interface Env {
	/** `api-key` (default) or `oauth-passthrough`. */
	AUTH_MODE?: string;
	/** Comma-separated list of client tokens. Secret. */
	PROXY_TOKENS?: string;
	/** Anthropic Console key. Secret. Used only in `api-key` mode. */
	ANTHROPIC_API_KEY?: string;
	/** Requests per minute per client token, per isolate. `0` disables. */
	RATE_LIMIT_PER_MINUTE?: string;
	/** Comma-separated browser origins allowed to call the Worker. Empty = none. */
	ALLOWED_ORIGINS?: string;
}

export interface Config {
	authMode: AuthMode;
	proxyTokens: string[];
	anthropicApiKey: string | undefined;
	rateLimitPerMinute: number;
	allowedOrigins: string[];
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function loadConfig(env: Env): Config {
	const rawMode = (env.AUTH_MODE ?? "").trim();
	let authMode: AuthMode;
	if (rawMode === "" || rawMode === "api-key") {
		authMode = "api-key";
	} else if (rawMode === "oauth-passthrough") {
		authMode = "oauth-passthrough";
	} else {
		throw new ConfigError(`AUTH_MODE must be "api-key" or "oauth-passthrough"`);
	}

	const proxyTokens = splitList(env.PROXY_TOKENS);
	if (proxyTokens.length === 0) {
		throw new ConfigError("PROXY_TOKENS is not set");
	}

	const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
	if (authMode === "api-key" && !anthropicApiKey) {
		throw new ConfigError("ANTHROPIC_API_KEY is not set (required in api-key mode)");
	}

	const rawLimit = (env.RATE_LIMIT_PER_MINUTE ?? "").trim();
	const rateLimitPerMinute = rawLimit === "" ? DEFAULT_RATE_LIMIT_PER_MINUTE : Number(rawLimit);
	if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 0) {
		throw new ConfigError("RATE_LIMIT_PER_MINUTE must be a non-negative integer");
	}

	return {
		authMode,
		proxyTokens,
		// Never hand the Console key to oauth-passthrough code paths.
		anthropicApiKey: authMode === "api-key" ? anthropicApiKey : undefined,
		rateLimitPerMinute,
		allowedOrigins: splitList(env.ALLOWED_ORIGINS),
	};
}
