// An archive is a full build of its own tag, so its chrome is whatever that
// release shipped — the older ones have no version picker at all, and a reader
// who lands there has no way back. The banner is injected after the build so
// every archive carries the same switching chrome regardless of its vintage,
// and it reads the version list from the live site rather than from the frozen
// tag, which cannot know about releases that came after it.

export const BANNER_MARKER = "<!--agentkit-archive-banner-->";
export const BANNER_ID = "agentkit-archive-banner";
export const VERSIONS_URL = "/docs/versions.json";

const escapeHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Neutral by construction: the banner sits on top of five different eras of this
// site's design, so it borrows nothing from the page — no CSS variables, no
// inherited font, no class names that a tag-era stylesheet might also define.
const style = `
#${BANNER_ID}{position:sticky;top:0;z-index:2147483647;box-sizing:border-box;
display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:.25rem .75rem;
padding:.5rem 1rem;margin:0;border:0;border-bottom:1px solid #d4d4d8;background:#f4f4f5;
color:#18181b;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
font-size:13px;line-height:1.4;text-align:center}
#${BANNER_ID} a{color:inherit;text-decoration:underline;text-underline-offset:.2em}
#${BANNER_ID} select{box-sizing:border-box;padding:.15rem .35rem;border:1px solid #a1a1aa;
background:#fff;color:#18181b;font:inherit;cursor:pointer;max-width:100%}
@media (prefers-color-scheme:dark){
#${BANNER_ID}{border-bottom-color:#3f3f46;background:#18181b;color:#e4e4e7}
#${BANNER_ID} select{border-color:#52525b;background:#27272a;color:#e4e4e7}}
:root[data-theme="light"] #${BANNER_ID}{border-bottom-color:#d4d4d8;background:#f4f4f5;color:#18181b}
:root[data-theme="light"] #${BANNER_ID} select{border-color:#a1a1aa;background:#fff;color:#18181b}
:root[data-theme="dark"] #${BANNER_ID}{border-bottom-color:#3f3f46;background:#18181b;color:#e4e4e7}
:root[data-theme="dark"] #${BANNER_ID} select{border-color:#52525b;background:#27272a;color:#e4e4e7}
`.replace(/\n/g, "");

// The offset is measured rather than assumed: these pages carry headers this
// code has never seen, and a fixed one sits at the viewport top where the
// banner also wants to be. Anything already pinned to 0 moves down by the
// banner's height, which is the only way to stay off a header whose selectors
// and variables are unknown here.
const script = `(function(){
var b=document.getElementById(${JSON.stringify(BANNER_ID)});
if(!b)return;
var slug=b.getAttribute("data-slug")||"";
function shift(){
var h=b.offsetHeight;
document.documentElement.style.scrollPaddingTop=h+"px";
var nodes=document.body.querySelectorAll("*");
for(var i=0;i<nodes.length;i++){
var el=nodes[i];
if(el===b||b.contains(el))continue;
if(el.getAttribute("data-agentkit-shifted")==="1"){el.style.top=h+"px";continue;}
var cs=window.getComputedStyle(el);
if((cs.position==="fixed"||cs.position==="sticky")&&parseFloat(cs.top)===0){
el.setAttribute("data-agentkit-shifted","1");el.style.top=h+"px";}}}
shift();
window.addEventListener("resize",shift);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(shift);
fetch(${JSON.stringify(VERSIONS_URL)},{cache:"no-cache"}).then(function(r){
if(!r.ok)throw new Error(String(r.status));return r.json();}).then(function(data){
var versions=data&&data.versions;
if(!Array.isArray(versions)||versions.length<2)return;
var link=b.querySelector("a");
if(!link)return;
var select=document.createElement("select");
select.setAttribute("aria-label","Select documentation version");
for(var i=0;i<versions.length;i++){
var option=document.createElement("option");
option.value=String(versions[i].path||"");
option.textContent=String(versions[i].label||"");
if(option.value==="/docs/"+slug+"/")option.selected=true;
select.appendChild(option);}
select.addEventListener("change",function(){window.location.pathname=select.value;});
link.replaceWith(select);
shift();
}).catch(function(){});
})();`.replace(/\n/g, "");

// The link is server-rendered and the select replaces it only once the list has
// actually arrived, so a failed fetch, a stale cache or no scripting at all
// still leaves a way back to the current docs.
export function bannerHtml(slug: string): string {
	const safe = escapeHtml(slug);
	return `${BANNER_MARKER}<div id="${BANNER_ID}" role="region" aria-label="Documentation version" data-slug="${safe}">`
		+ `<span>You are viewing the v${safe} documentation</span>`
		+ `<a href="/docs/">Back to the latest documentation &rarr;</a>`
		+ `</div><style>${style}</style><script>${script}</script>`;
}

export interface Injection {
	html: string;
	injected: boolean;
	reason?: "already-present" | "no-body";
}

export function injectBanner(html: string, slug: string): Injection {
	if (html.includes(BANNER_MARKER)) return { html, injected: false, reason: "already-present" };
	const body = /<body[^>]*>/i.exec(html);
	if (!body) return { html, injected: false, reason: "no-body" };
	const at = body.index + body[0].length;
	return { html: html.slice(0, at) + bannerHtml(slug) + html.slice(at), injected: true };
}
