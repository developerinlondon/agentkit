import { archivedReleases } from "./release";

// The archive builder reads the same list the picker renders, through this one
// entry point: a shell-side copy of the rule is how a build ends up offering a
// version it never built.
for (const { slug, tag } of archivedReleases()) {
	process.stdout.write(`${slug}\t${tag}\n`);
}
