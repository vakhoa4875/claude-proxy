import { tokenKey } from "../utils/crypto";
import { HttpError } from "../utils/errors";

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 1_000;

interface Window {
	start: number;
	count: number;
}

/**
 * Fixed-window limiter, per isolate, in memory only. It is a best-effort guard
 * against runaway loops, not a global quota: Cloudflare may run several
 * isolates, each with its own counters. Keys are truncated SHA-256 hashes of
 * the proxy token and are never persisted.
 */
export class RateLimiter {
	private readonly windows = new Map<string, Window>();

	constructor(private readonly now: () => number = Date.now) {}

	async check(clientToken: string, limitPerMinute: number): Promise<void> {
		if (limitPerMinute === 0) return;

		const key = await tokenKey(clientToken);
		const now = this.now();
		let window = this.windows.get(key);
		if (!window || now - window.start >= WINDOW_MS) {
			this.prune(now);
			window = { start: now, count: 0 };
			this.windows.set(key, window);
		}

		window.count += 1;
		if (window.count > limitPerMinute) {
			const retryAfter = Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000));
			throw new HttpError(429, "rate_limit_error", "claude-proxy rate limit exceeded", {
				"retry-after": String(retryAfter),
			});
		}
	}

	private prune(now: number): void {
		if (this.windows.size < MAX_TRACKED_KEYS) return;
		for (const [key, window] of this.windows) {
			if (now - window.start >= WINDOW_MS) this.windows.delete(key);
		}
	}
}
