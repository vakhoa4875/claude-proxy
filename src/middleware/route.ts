import { HttpError } from "../utils/errors";

/** The only upstream paths the Worker will ever call. */
export const ALLOWED_PATHS: ReadonlySet<string> = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export function checkRoute(request: Request, url: URL): void {
	if (!ALLOWED_PATHS.has(url.pathname)) {
		throw new HttpError(404, "not_found_error", "Not found");
	}
	if (request.method !== "POST") {
		throw new HttpError(405, "invalid_request_error", "Method not allowed", { allow: "POST" });
	}
}
