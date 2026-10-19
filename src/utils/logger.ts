/**
 * Structured, redacted logging.
 *
 * Log records are built only from an explicit allowlist of fields; request
 * headers are never logged. Free-text values (error messages) are scrubbed of
 * every secret known for the request plus generic credential patterns, so a
 * credential that leaks into an exception message still never reaches
 * `wrangler tail`.
 */

const GENERIC_SECRET_PATTERNS: RegExp[] = [
	/Bearer\s+[^\s"',;]+/gi,
	/sk-ant-[A-Za-z0-9_-]+/g,
];

export const REDACTED = "[REDACTED]";

export class Redactor {
	private readonly secrets: string[] = [];

	add(value: string | null | undefined): void {
		if (!value) return;
		const trimmed = value.trim();
		if (trimmed.length === 0) return;
		this.secrets.push(trimmed);
		// Also catch the bare token when the header carried a scheme prefix.
		const parts = trimmed.split(/\s+/);
		const last = parts[parts.length - 1];
		if (parts.length > 1 && last && last.length >= 8) this.secrets.push(last);
	}

	redact(text: string): string {
		let out = text;
		// Longest first so a full header value is replaced before its suffix.
		for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
			out = out.split(secret).join(REDACTED);
		}
		for (const pattern of GENERIC_SECRET_PATTERNS) {
			out = out.replace(pattern, REDACTED);
		}
		return out;
	}
}

export interface RequestLog {
	event: "request";
	request_id: string;
	auth_mode: string;
	method: string;
	path: string;
	status: number;
	duration_ms: number;
	upstream_status?: number;
	outcome: string;
	error?: string;
	/** Short reason from a non-2xx upstream body: `type: message`, or an HTML page title. */
	upstream_error?: string;
}

/**
 * Condenses an upstream error body into one short, redacted line so the
 * reason for a 4xx/5xx shows up in `wrangler tail`. Only the error type and
 * message are kept from JSON bodies; HTML pages are reduced to their title.
 */
export function describeUpstreamError(body: string, redactor: Redactor): string {
	let summary: string | undefined;
	try {
		const parsed = JSON.parse(body) as { error?: { type?: unknown; message?: unknown } };
		const { type, message } = parsed.error ?? {};
		if (typeof type === "string" || typeof message === "string") {
			summary = [type, message].filter((part) => typeof part === "string").join(": ");
		}
	} catch {
		// Not JSON; fall through.
	}
	if (summary === undefined) {
		const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1];
		summary = (title ?? body.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
	}
	return redactor.redact(summary).slice(0, 300);
}

export function describeError(error: unknown, redactor: Redactor): string {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return redactor.redact(`${name}: ${message}`).slice(0, 500);
}

export function logRequest(record: RequestLog, redactor: Redactor): void {
	const line = redactor.redact(JSON.stringify(record));
	if (record.status >= 500) {
		console.error(line);
	} else {
		console.log(line);
	}
}
