import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://agentkit.sbs",
	base: "/docs",
	trailingSlash: "always",
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
			],
		}),
	],
});
