import { ConfigError, loadConfig, type Config, type Env } from "./config";
import { authenticate, PROXY_TOKEN_HEADER } from "./middleware/auth";
import { applyCorsHeaders, checkOrigin, preflightResponse } from "./middleware/cors";
import { RateLimiter } from "./middleware/rate-limit";
import { checkRoute } from "./middleware/route";
import { proxyToAnthropic } from "./services/anthropic-proxy";
import { errorResponse, HttpError } from "./utils/errors";
import { describeError, describeUpstreamError, logRequest, Redactor, type RequestLog } from "./utils/logger";

export type { Env } from "./config";

const rateLimiter = new RateLimiter();

export async function handleRequest(request: Request, env: Env, limiter: RateLimiter = rateLimiter): Promise<Response> {
	const startedAt = Date.now();
	const url = new URL(request.url);
	// Register every credential before anything can fail, so all log output
	// for this request is scrubbed of them.
	const redactor = new Redactor();
	redactor.add(env.ANTHROPIC_API_KEY);
	redactor.add(request.headers.get("authorization"));
	redactor.add(request.headers.get("x-api-key"));
	redactor.add(request.headers.get(PROXY_TOKEN_HEADER));

	const log: RequestLog = {
		event: "request",
		request_id: request.headers.get("cf-ray") ?? crypto.randomUUID(),
		auth_mode: "unknown",
		method: request.method,
		path: url.pathname,
		status: 0,
		duration_ms: 0,
		outcome: "ok",
	};

	let origin: string | undefined;
	let response: Response;
	try {
		let config: Config;
		try {
			config = loadConfig(env);
		} catch (error) {
			if (error instanceof ConfigError) {
				throw new HttpError(500, "api_error", `claude-proxy misconfigured: ${error.message}`);
			}
			throw error;
		}
		log.auth_mode = config.authMode;

		origin = checkOrigin(request, config);
		if (request.method === "OPTIONS" && origin !== undefined) {
			log.outcome = "preflight";
			response = preflightResponse(request, origin);
		} else {
			checkRoute(request, url);
			const { clientToken } = await authenticate(request, config);
			await limiter.check(clientToken, config.rateLimitPerMinute);

			try {
				response = await proxyToAnthropic(request, url, config);
			} catch (error) {
				if (request.signal.aborted) {
					log.outcome = "client_cancelled";
					log.error = describeError(error, redactor);
					response = errorResponse(499, "api_error", "Client closed request");
				} else {
					throw error;
				}
			}
			if (log.outcome === "ok") {
				log.upstream_status = response.status;
				log.outcome = response.ok ? "ok" : "upstream_error";
				if (!response.ok) {
					// Error bodies are small and never streamed; read once so the
					// reason can be logged, then return the same bytes unchanged.
					const body = await response.text();
					log.upstream_error = describeUpstreamError(body, redactor);
					response = new Response(body, response);
				}
			}
		}
	} catch (error) {
		if (error instanceof HttpError) {
			log.outcome = "rejected";
			log.error = describeError(error, redactor);
			response = errorResponse(error.status, error.type, error.message, error.headers);
		} else {
			log.outcome = "gateway_error";
			log.error = describeError(error, redactor);
			response = errorResponse(502, "api_error", "claude-proxy could not reach the Anthropic API");
		}
	}

	if (origin !== undefined && response.status !== 204) {
		// Response headers from fetch() are immutable; copy before adding CORS.
		response = new Response(response.body, response);
		applyCorsHeaders(response.headers, origin);
	}

	log.status = response.status;
	log.duration_ms = Date.now() - startedAt;
	logRequest(log, redactor);
	return response;
}

export default {
	fetch(request, env): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
