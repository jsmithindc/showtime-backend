// Cloudflare Worker: simple GET proxy for fetching Atom Tickets pages
// from a non-datacenter IP. Deploy free at workers.dev (100k req/day).
//
// Setup:
//   1. wrangler deploy (or paste into the Workers dashboard)
//   2. Set secret: wrangler secret put ATOM_PROXY_SECRET
//   3. Add to Render env vars:
//        ATOM_PROXY_URL=https://your-worker.your-subdomain.workers.dev
//        ATOM_PROXY_SECRET=<same secret>

export default {
  async fetch(request, env) {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url");
    const secret = searchParams.get("secret");

    if (!target) {
      return new Response("missing url param", { status: 400 });
    }

    if (env.ATOM_PROXY_SECRET && secret !== env.ATOM_PROXY_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }

    // Only allow Atom Tickets URLs
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("invalid url", { status: 400 });
    }
    if (targetUrl.hostname !== "www.atomtickets.com") {
      return new Response("only atomtickets.com URLs allowed", { status: 403 });
    }

    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "text/html" },
    });
  },
};
