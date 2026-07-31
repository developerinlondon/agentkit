import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// The docs are one section of agentkit.sbs, not the whole site, and the title is
// the only way back out to it; Starlight would otherwise point it at /docs/,
// which is the page the reader is already on.
export const onRequest = defineRouteMiddleware((context) => {
	context.locals.starlightRoute.siteTitleHref = "/";
});
