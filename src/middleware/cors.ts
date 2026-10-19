import type { Config } from "../config";
import { HttpError } from "../utils/errors";

/**
 * Claude Code is not a browser and sends no `Origin`. Browser requests are
 * refused unless their origin is listed in ALLOWED_ORIGINS.
 */
export function checkOrigin(request: Request, config: Config): string | undefined {
	const origin = request.headers.get("origin");
	if (origin === null) return undefined;
	if (!config.allowedOrigins.includes(origin)) {
		throw new HttpError(403, "permission_error", "Origin not allowed");
	}
	return origin;
}

export function preflightResponse(request: Request, origin: string): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"access-control-allow-origin": origin,
			"access-control-allow-methods": "POST, OPTIONS",
			"access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "",
			"access-control-max-age": "600",
			vary: "Origin",
		},
	});
}

export function applyCorsHeaders(headers: Headers, origin: string | undefined): void {
	if (origin === undefined) return;
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-expose-headers", "*");
	headers.append("vary", "Origin");
}
