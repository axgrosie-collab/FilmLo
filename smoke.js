// smoke test — kiểm tra toàn bộ API + trang chi tiết + player
process.env.PORT = process.env.PORT || "4000";
process.chdir("c:/Users/nguye/Desktop/Filmlo");
require("./server.js");

setTimeout(async () => {
  const base = "http://127.0.0.1:" + (process.env.PORT || 3000);
  let fail = 0;

  async function check(url, { expectJson = true } = {}) {
    try {
      const r = await fetch(base + url);
      const t = await r.text();
      const ok = r.ok && (!expectJson || t.trim().startsWith("{"));
      console.log(ok ? "PASS" : "FAIL", r.status, url, "-", t.length, "bytes");
      if (!ok) fail++;
      return expectJson ? (() => { try { return JSON.parse(t); } catch { return null; } })() : t;
    } catch (e) {
      console.log("FAIL ERR", url, "-", e.message);
      fail++;
      return null;
    }
  }

  // endpoints cơ bản
  await check("/");
  await check("/api/categories");
  await check("/api/countries");
  await check("/api/movies?page=1");
  await check("/api/list/phim-le?page=1");
  await check("/api/list/phim-bo?page=1");
  await check("/api/filter/phim-le?sort_field=view&sort_type=desc&page=1");
  const search = await check("/api/search?keyword=one%20piece&page=1");
  const items = search?.items || [];
  console.log(items.length ? `PASS search returned ${items.length} items` : "FAIL search returned 0 items");
  if (!items.length) fail++;

  // chi tiết phim + player
  const slug = items[0]?.slug || "one-piece";
  const movie = await check(`/api/movie/${encodeURIComponent(slug)}`);
  if (movie?.success !== true) { console.log("FAIL /api/movie success!=true"); fail++; }
  const m = movie?.movie;
  const eps = movie?.episodes?.flatMap(s => s.server_data || []) ||
    m?.episodes?.flatMap(s => s.server_data || []) || [];
  if (m && eps.length) {
    console.log(`PASS movie "${m.name}" with ${eps.length} episodes`);
  } else {
    console.log("FAIL movie detail missing episodes");
    fail++;
  }
  if (eps.some(e => e.link_m3u8)) console.log("PASS m3u8 links available");
  if (eps.some(e => e.link_embed)) console.log("PASS embed links available");

  await check(`/phim/${slug}`, { expectJson: false });

  console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
  process.exit(fail ? 1 : 0);
}, 3000);
