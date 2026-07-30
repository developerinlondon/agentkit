import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// The hand-built pages these replaced are already indexed and linked. Each keeps
// resolving to its nearest equivalent rather than 404ing, because a docs URL that
// dies takes its inbound links with it.
//
// Keys are base-relative and targets are not: Astro prepends `base` to the route
// it generates but writes the destination verbatim, so a key of `/docs/install`
// would publish the redirect at `/docs/docs/install`.
const MIGRATED = {
	"/install": "/docs/getting-started/install/",
	"/concepts": "/docs/concepts/four-surfaces/",
	"/architecture": "/docs/concepts/four-surfaces/",
	"/hooks": "/docs/reference/hooks/",
	"/configuration": "/docs/reference/configuration/",
	"/skills": "/docs/reference/skills/",
	"/examples": "/docs/cookbook/",
	"/pages": "/docs/concepts/pages/",
	"/product": "/docs/concepts/product/",
	"/diagrams": "/docs/concepts/diagrams/",
};

export default defineConfig({
	site: "https://agentkit.sbs",
	base: "/docs",
	trailingSlash: "always",
	redirects: MIGRATED,
	integrations: [
		starlight({
			title: "agentkit",
			description: "Discipline for coding agents: hooks that refuse, skills that instruct.",
			customCss: ["./src/styles/agentkit.css"],
			pagefind: true,
			sidebar: [
				{ label: "Introduction", link: "/" },
				{
					label: "Getting started",
					items: [{ autogenerate: { directory: "getting-started" } }],
				},
				{ label: "Thinking in agentkit", link: "/thinking/" },
				{ label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
				{ label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
				{ label: "Cookbook", items: [{ autogenerate: { directory: "cookbook" } }] },
				{ label: "Community", items: [{ autogenerate: { directory: "community" } }] },
			],
		}),
	],
});
