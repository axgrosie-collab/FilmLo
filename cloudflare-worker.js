// Filmlo — Nguonc relay (Cloudflare Worker)
// Cloudflare Worker có IP riêng của mạng Cloudflare → không bị Nguonc chặn
// như IP data center của Railway.
//
// CÁCH DÙNG:
// 1. Vào https://workers.cloudflare.com → tạo tài khoản (miễn phí) → Create Worker
// 2. Dán toàn bộ code này vào → Deploy
// 3. Vào Railway → Variables → thêm:
//        NGUONC_PROXY = https://filmlo-nguonc.<tài-khoản>.workers.dev
//    (URL workers.dev của worker vừa tạo — không có dấu / cuối)
// 4. Railway tự redeploy → nguồn 2 hoạt động trở lại.
//
// Worker forward mọi request tới phim.nguonc.com, giữ nguyên đường dẫn.
// VD: https://...workers.dev/api/film/slug → https://phim.nguonc.com/api/film/slug

export default {
  async fetch(request) {
    const url = new URL(request.url);
    /* Two modes:
       1) /stream?url=<encoded> — for Filmlo's /api/stream (m3u8/ts/any URL)
       2) everything else — forwards path+query to phim.nguonc.com (Nguonc relay) */
    let target;
    if (url.pathname === "/stream") {
      target = url.searchParams.get("url");
      if (!target) return new Response("missing url", { status: 400 });
    } else {
      target = "https://phim.nguonc.com" + url.pathname + url.search;
    }

    let referer;
    try { referer = new URL(target).origin + "/"; } catch { referer = "https://phim.nguonc.com/"; }

    const resp = await fetch(target, {
      method: request.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Referer": referer
      },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body
    });

    // trả về nguyên kết quả + header CORS để không bị chặn từ browser nếu cần
    const headers = new Headers(resp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=300");
    return new Response(resp.body, { status: resp.status, headers });
  }
};
