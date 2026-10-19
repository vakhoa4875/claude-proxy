const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/**
 * Constant-time membership check. Both sides are hashed first so the
 * comparison always runs over equal-length buffers, and every candidate is
 * compared (no early exit) so timing doesn't reveal which token matched.
 */
export async function matchesAnyToken(candidate: string, tokens: readonly string[]): Promise<boolean> {
	const candidateHash = await sha256(candidate);
	let matched = false;
	for (const token of tokens) {
		const tokenHash = await sha256(token);
		if (crypto.subtle.timingSafeEqual(candidateHash, tokenHash)) matched = true;
	}
	return matched;
}

/** Short, non-reversible, in-memory-only key for rate limiting. */
export async function tokenKey(token: string): Promise<string> {
	const bytes = new Uint8Array(await sha256(token));
	return Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
