// Cloudflare Worker: lets the planner read calendar subscription links (Canvas and iCloud block direct reads from other sites).
// Only forwards Canvas feeds (…/feeds/calendars/user_….ics) and iCloud public calendars (p…-caldav.icloud.com/published/2/…),
// and only answers the planner's own pages.
const ALLOWED_ORIGINS = ["https://jiayi61.github.io", "http://localhost:5174"];
const FEEDS = [
  /^https:\/\/[a-z0-9.-]+\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/, // Canvas
  /^https:\/\/p\d+-caldav\.icloud\.com\/published\/2\/[A-Za-z0-9_-]+$/, // iCloud public calendar
];

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("origin not allowed", { status: 403, headers: cors });
    const target = new URL(req.url).searchParams.get("url") || "";
    if (!FEEDS.some((re) => re.test(target))) return new Response("only Canvas or iCloud calendar links are allowed", { status: 400, headers: cors });
    const r = await fetch(target, { headers: { Accept: "text/calendar" }, redirect: "follow" });
    const body = await r.text();
    if (!r.ok || !body.includes("BEGIN:VCALENDAR")) return new Response(`calendar server answered ${r.status}`, { status: 502, headers: cors });
    return new Response(body, { headers: { ...cors, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" } });
  },
};
