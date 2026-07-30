// An archived version is a verbatim copy of the pages, so its tables still import
// the live components. Without this, a frozen page would render today's tree and
// quietly describe a release it is not. The version is recovered from the URL
// rather than passed as a prop, because nothing edits the pages after archiving.

export interface VersionedFacts {
	units: unknown[];
	wiring: unknown[];
	groups: unknown[];
	skills: unknown[];
	tools: unknown[];
}

const VERSION_SEGMENT = /^\d+(?:\.\d+)*$/;

export function versionFromPathname(pathname: string, base = "/docs"): string | null {
	const trimmed = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
	const segment = trimmed.split("/").find((part) => part !== "");
	return segment && VERSION_SEGMENT.test(segment) ? segment : null;
}

// A declared version with no frozen snapshot falls back to the current tree and
// says so, rather than rendering an empty table that reads as "no units".
export function factsFor<T extends VersionedFacts>(
	pathname: string,
	current: T,
	frozen: Record<string, T>,
	base = "/docs",
): { facts: T; version: string | null; frozen: boolean } {
	const version = versionFromPathname(pathname, base);
	if (version === null) return { facts: current, version: null, frozen: false };
	const snapshot = frozen[version];
	return snapshot
		? { facts: snapshot, version, frozen: true }
		: { facts: current, version, frozen: false };
}

// import.meta.glob keys are module paths; the version is the basename.
export function frozenByVersion<T extends VersionedFacts>(
	modules: Record<string, { default: T } | T>,
): Record<string, T> {
	const byVersion: Record<string, T> = {};
	for (const [path, module] of Object.entries(modules)) {
		const name = path.split("/").pop()?.replace(/\.json$/, "");
		if (!name) continue;
		byVersion[name] = (module as { default?: T }).default ?? (module as T);
	}
	return byVersion;
}
