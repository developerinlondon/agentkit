import { bannerHash } from "./archive-banner";
import { archivedReleases } from "./release";

// One entry point for the builder and the picker: a shell-side copy of the rule
// is how a build ends up offering a version it never built. The hash column is
// what lets the builder tell a published archive from one it must rebuild.
for (const { slug, tag } of archivedReleases()) {
	process.stdout.write(`${slug}\t${tag}\t${bannerHash(slug)}\n`);
}
