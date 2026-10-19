/**
 * Errors produced by the Worker itself (not by Anthropic), shaped like
 * Anthropic API errors so Claude Code renders them normally.
 */
export class HttpError extends Error {
	override name = "HttpError";

	constructor(
		readonly status: number,
		readonly type: string,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message);
	}
}

export function errorResponse(
	status: number,
	type: string,
	message: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			...headers,
		},
	});
}
