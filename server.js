/**
 * Filmlo — proxy cho phimapi.com (KKPhim API)
 * Deploy Railway: npm start (PORT do Railway cấp)
 */

const express = require("express");
const compression = require("compression");
const path = require("path");

const app = express();

/* Railway chạy sau proxy -> tin địa chỉ IP của client */
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const API = "https://phimapi.com";

/* ---------- Log truy cập (xem trên Railway: Deployments → Logs) ---------- */
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
        if (req.path === "/health") return;
        const ms = Date.now() - t0;
        const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
        const ua = (req.headers["user-agent"] || "").slice(0, 60);
        const size = res.get("Content-Length") || "-";
        console.log(
            `[${new Date().toISOString()}] ${ip} "${req.method} ${req.originalUrl}" ` +
            `${res.statusCode} ${ms}ms ${size} "${ua}"`
        );
    });
    next();
});

/* Nén gzip mọi response (HTML/JSON nặng -> nhỏ hơn 5-10 lần) */
app.use(compression());

/* ===== CHẶN QUẢNG CÁO CÁ ĐỘ =====
   Phát m3u8 bằng player của mình là chính; iframe embed (dự phòng) bị chặn
   pop-up/redirect bằng sandbox="allow-scripts allow-same-origin allow-presentation"
   — KHÔNG có allow-popups / allow-top-navigation nên quảng cáo không tự mở tab mới
   hay điều hướng trang đi đâu cả. YouTube trailer vẫn hoạt động bình thường. */
app.use((req, res, next) => {
    /* frame-src: cho phép embed player của các nguồn (dự phòng) + YouTube trailer.
       Quảng cáo pop-up vẫn bị chặn nhờ iframe sandbox phía client. */
    res.set("Content-Security-Policy",
        "frame-src 'self' https:; " +
        "child-src 'self' https:");
    next();
});

/* Static: HTML không cache (deploy mới có hiệu lực ngay), JS lib cache lâu */
app.use(express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
            res.set("Cache-Control", "no-cache");
        } else {
            res.set("Cache-Control", "public, max-age=604800, immutable");
        }
    }
}));

/* Healthcheck cho Railway */

/* ---------- STREAM PROXY: tải m3u8, LỌC BỎ quảng cáo, trả lại ----------
   Nguồn video chèn quảng cáo vào TRONG manifest (các segment có tiền tố
   khác biệt như "convertv7/...", nằm giữa cặp #EXT-X-DISCONTINUITY).
   Proxy tải manifest, xóa mọi segment quảng cáo rồi trả lại cho player.
   Player không bao giờ tải quảng cáo → không còn pop-up/banner cá độ. */
const AD_SEGMENT_PATTERNS = [
    /convertv7\//,      // quảng cáo của nguồn phim1280 (chính là dạng này)
    /\/ad\//,           // các đường dẫn kiểu .../ad/...
    /^ad[-_.]/,         // ad-xxx.ts
    /advert/,           // advert...
    /doubleclick/,
    /googlesyndication/
];

app.get("/api/stream", async (req, res) => {
    try {
        const url = String(req.query.url || "");
        if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "bad url" });
        /* fetch qua 2 đường: (1) gọi thẳng, (2) worker relay nếu cấu hình.
           CDN nguồn (phim1280...) chặn data center nước ngoài → Railway phải
           đi qua worker Cloudflare (như cách đã xử lý với Nguonc). */
        const referer = new URL(url).origin + "/";
        const fetchUpstream = async (u) => {
            const r = await fetch(u, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                    "Referer": referer,
                    "Accept": "*/*"
                },
                signal: AbortSignal.timeout(15000)
            });
            return r;
        };
        let upstream;
        let body = null;
        /* Đường 1: gọi thẳng. Lỗi → Đường 2: worker relay (nếu cấu hình).
           CDN nguồn chặn data center nước ngoài → Railway cần worker. */
        try {
            upstream = await fetchUpstream(url);
            if (!upstream.ok) throw new Error("HTTP " + upstream.status);
            body = await upstream.text();
        } catch (e1) {
            if (process.env.NGUONC_PROXY) {
                const proxied = process.env.NGUONC_PROXY.replace(/\/+$/, "")
                    + "/stream?url=" + encodeURIComponent(url);
                const r2 = await fetch(proxied, { signal: AbortSignal.timeout(15000) });
                if (!r2.ok) throw new Error("upstream " + r2.status + " & worker " + e1.message);
                body = await r2.text();
            } else {
                throw e1;
            }
        }
        if (body.includes("#EXTM3U")) {
            /* manifest:rewrite các segment相对 thành URL tuyệt đối qua proxy của mình,
               và LỌC BỎ các segment quảng cáo + cặp DISCONTINUITY bao quanh */
            const base = new URL(url);
            const lines = body.split(/\r?\n/);
            const out = [];
            let pendingDiscontinuities = 0;
            let droppedSegments = 0;
            for (const line of lines) {
                const t = line.trim();
                if (!t) { continue; }
                if (t.startsWith("#")) {
                    if (t === "#EXT-X-DISCONTINUITY") { pendingDiscontinuities++; continue; }
                    /* các thẻ khác giữ nguyên (EXTM3U, VERSION, KEY, EXTINF...) */
                    out.push(t);
                    continue;
                }
                /* dòng segment (.ts/.m3s/.mp4) */
                const isAd = AD_SEGMENT_PATTERNS.some(p => p.test(t));
                if (isAd) { droppedSegments++; pendingDiscontinuities = 0; continue; }
                /* segment hợp lệ: rewrite thành URL tuyệt đối qua proxy,
                   để player tải đúng (kể cả URI tương đối trong playlist con) */
                let abs;
                try { abs = new URL(t, base).toString(); } catch { abs = t; }
                out.push("/api/stream?url=" + encodeURIComponent(abs));
            }
            /* dọn các DISCONTINUITY dư ở cuối */
            while (out.length && out[out.length - 1].startsWith("#EXT-X-DISCONTINUITY")) out.pop();
            body = out.join("\n");
            res.set("Cache-Control", "public, max-age=300");
            res.set("Content-Type", "application/vnd.apple.mpegurl");
            return res.send(body);
        }
        /* không phải manifest → trả nguyên (player sẽ tự xử lý) */
        res.set("Cache-Control", "public, max-age=300");
        return res.send(body);
    } catch (e) {
        console.error("stream-proxy", e.message);
        res.status(502).json({ error: "proxy fail" });
    }
});
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/* ---------- Cache in-memory (TTL 5 phút) ---------- */

const cache = new Map();
const TTL = 5 * 60 * 1000;

function cacheGet(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL) return hit.data;
    cache.delete(key);
    return null;
}

function cacheSet(key, data) {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(key, { t: Date.now(), data });
}

/* ---------- Helper fetch chung (KKPhim) ---------- */

async function fetchJson(url) {
    const cached = cacheGet(url);
    if (cached) return cached;

    const response = await fetch(url, {
        headers: { "User-Agent": "Filmlo/1.0" },
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(`Upstream HTTP ${response.status}`);
    }

    const data = await response.json();
    cacheSet(url, data);
    return data;
}

/* ---------- Nguonc gateway: đường đi sạch, không proxy chết ----------
   Railway đặt region Singapore (gần VN) -> gọi thẳng Nguonc OK, worker
   relay (NGUONC_PROXY) cũng OK. Các proxy công cộng (allorigins, corsproxy,
   r.jina.ai...) đã bị BỎ vì chết/hạn chế và mỗi lần fail tốn ~12s timeout
   làm chậm toàn endpoint nguồn 2. Thứ tự: thẳng -> worker riêng nếu set. */
const NGUONC_ORIG = "https://phim.nguonc.com/api";
const API2 = process.env.NGUONC_PROXY
    ? `${String(process.env.NGUONC_PROXY).replace(/\/+$/, "")}/api`
    : NGUONC_ORIG;
const NGUONC_GATEWAYS = [
    (u) => u,                                                          // 0: gọi thẳng
    ...(process.env.NGUONC_PROXY
        ? [(u) => `${API2}${u.slice(NGUONC_ORIG.length)}`] : [])       // 1: worker relay riêng
];
let nguoncGateway = -1;

/* Header giả lập trình duyệt: Cloudflare của Nguonc chặn UA server thuần */
const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8"
};

async function fetchJsonNguonc(url, depth = 0) {
    if (depth >= NGUONC_GATEWAYS.length)
        throw new Error("Nguonc: tất cả gateway đều thất bại");
    const idx = depth === 0 && nguoncGateway >= 0 ? nguoncGateway : depth;
    const target = NGUONC_GATEWAYS[idx](url);
    try {
        const cached = cacheGet(target);
        if (cached) return cached;
        const response = await fetch(target, {
            headers: BROWSER_HEADERS,
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        cacheSet(target, data);
        if (idx !== nguoncGateway) {
            nguoncGateway = idx;
            console.log(`nguonc gateway #${idx} hoạt động`);
        }
        return data;
    } catch (e) {
        console.error(`nguonc gateway #${idx} FAIL: ${e.message}`);
        if (depth === 0) { nguoncGateway = -1; }
        return fetchJsonNguonc(url, depth + 1);
    }
}

/* Chuẩn hóa 1 item Nguonc về cùng shape field như KKPhim để frontend dùng chung */
function normalizeNguoncItem(m) {
    if (!m) return null;
    /* Nguonc trả category là chuỗi "Hành Động, Phiêu Lưu" -> tách thành mảng {name} */
    let cats = [];
    if (Array.isArray(m.category)) cats = m.category;
    else if (typeof m.category === "string")
        cats = m.category.split(",").map(n => ({ name: n.trim() })).filter(c => c.name);
    return {
        ...m,
        _nguonc: true,
        category: cats,
        name: m.name || "",
        origin_name: m.original_name || m.origin_name || "",
        poster_url: m.poster_url_webp || m.poster_url || "",
        thumb_url: m.thumb_url_webp || m.thumb_url || "",
        episode_current: m.current_episode || "",
        quality: m.quality || ""
    };
}

/* ---------- Route factory: gom toàn bộ endpoint danh sách ---------- */

function listRoute(path, buildUrl) {
    app.get(path, async (req, res) => {
        try {
            const q = { ...req.params, ...(req.query || {}) };
            const page = Math.max(1, Number(q.page) || 1);
            const data = await fetchJson(buildUrl({ ...q, page }));
            /* khử trùng các bản giống nhau (cùng bộ phim, khác season/nguồn):
               áp dụng cho MỌI endpoint danh sách -> grid không còn thẻ trùng */
            if (Array.isArray(data?.items)) data.items = dedupeList(data.items);
            if (Array.isArray(data?.data?.items)) data.data.items = dedupeList(data.data.items);
            res.set("Cache-Control", "public, max-age=300");
            res.json(data);
        } catch (error) {
            console.error(path, error.message);
            res.status(502).json({ success: false, message: "Không tải được dữ liệu." });
        }
    });
}

/* Phim mới cập nhật — dùng NGUỒN 1 (KKPhim) cho ĐỒNG BỘ ảnh với các tab khác */
app.get("/api/movies", async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const data = await fetchJson(
            `${API}/v1/api/danh-sach/phim-moi-cap-nhat?page=${page}&limit=20`
        );
        const items = dedupeList(data?.items || data?.data?.items || []);
        const paginate = data?.data?.paginate || data?.paginate || null;
        res.set("Cache-Control", "public, max-age=300");
        res.json({ items, paginate });
    } catch (error) {
        console.error("/api/movies", error.message);
        res.status(502).json({ success: false, message: "Không tải được dữ liệu." });
    }
});

/* Danh sách theo loại: phim-bo, phim-le, tv-shows, hoat-hinh */
listRoute("/api/list/:slug", q =>
    `${API}/v1/api/danh-sach/${encodeURIComponent(q.slug)}?page=${q.page}&limit=48`
);

/* Theo thể loại */
listRoute("/api/category/:slug", q =>
    `${API}/v1/api/the-loai/${encodeURIComponent(q.slug)}?page=${q.page}&limit=48`
);

/* Theo quốc gia */
listRoute("/api/country/:slug", q =>
    `${API}/v1/api/quoc-gia/${encodeURIComponent(q.slug)}?page=${q.page}&limit=48`
);

/* Theo năm */
listRoute("/api/year/:year", q =>
    `${API}/v1/api/nam/${encodeURIComponent(q.year)}?page=${q.page}&limit=48`
);

/* Khóa khử trùng cho 1 phim: slug + tên gốc (bỏ dấu, khoảng trắng, ký tự đặc biệt). */
function dedupeKey(m) {
    const norm = s => String(s || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // bỏ dấu tiếng Việt
        .replace(/[^a-z0-9]/g, "");               // chỉ giữ chữ + số
    const a = norm(m.name), b = norm(m.origin_name);
    return [norm(m.slug), a, b].filter(Boolean).join("|");
}

/* TÊN NỀN TẢNG (baseKey): bỏ mọi dấu hiệu phân mùa/phần để gộp các bản
   "cùng một bộ phim" lại làm 1 thẻ. Ví dụ các tên sau đều -> "thanhguomdietquy":
   - "Thanh Gươm Diệt Quỷ (Phần 1)"
   - "Thanh Gươm Diệt Quỷ (Phần 1) (Kamado Academy...)"
   - "Demon Slayer (Season 1)"
   - "Kimetsu no Yaiba Season 2"
   Cách làm: bỏ nội dung trong ngoặc, bỏ từ khóa mùa/phần, bỏ số đuôi,
   bỏ các từ vô nghĩa (the, a) -> so khớp tên nền. */
function baseKey(m) {
    const pick = x => String(x || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\([^)]*\)/g, " ")                        // bỏ (Phần 1), (Season 2)...
        .replace(/\b(phan|season|saison|temporada|part)\s*\d+\b/g, " ")
        .replace(/\b(season|phan|part)\b/g, " ")
        .replace(/\b\d+\b/g, " ")                          // bỏ số đuôi còn sót
        .replace(/\b(the|a|an)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ").trim();
    const n = pick(m.name), o = pick(m.origin_name);
    return n || o || pick(m.slug) || "";
}

/* GỌP DANH SÁCH: khử trùng 2 tầng
   1) exact key (slug + tên gốc + tên) — bắt bản chính xác trùng lặp
   2) baseKey (tên nền) — bắt cùng một bộ phim nhưng đặt tên khác nhau
      (vd "Thanh Gươm Diệt Quỷ (Phần 1)" vs "Demon Slayer (Season 1)")
   Ưu tiên giữ bản Nguonc (ảnh đẹp hơn); nếu cùng nguồn giữ bản đầu tiên. */
function dedupeList(items) {
    const byExact = new Map();   // exact key -> item
    const byBase = new Map();    // baseKey  -> item
    const out = [];
    for (const m of items) {
        if (!m) continue;
        const s = m.slug || m.name;
        if (!s) continue;
        const ek = dedupeKey(m);
        if (byExact.has(ek)) {
            const prev = byExact.get(ek);
            if (m._nguonc && !prev._nguonc) {
                out[out.indexOf(prev)] = m;
                byExact.set(ek, m);
                byBase.set(baseKey(m), m);
            }
            continue;
        }
        const bk = baseKey(m);
        if (bk && byBase.has(bk)) continue;   // cùng bộ phim (khác mùa/tên) -> bỏ
        byExact.set(ek, m);
        if (bk) byBase.set(bk, m);
        out.push(m);
    }
    return out;
}

/* ---------- Tìm kiếm: GỘP 2 NGUỒN (KKPhim + Nguonc) ---------- */
app.get("/api/search", async (req, res) => {
    try {
        const keyword = String(req.query.keyword || "").trim();
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Number(req.query.limit) || 48);
        if (!keyword) return res.json({ items: [], paginate: null });

        const [kk, ng] = await Promise.all([
            fetchJson(`${API}/v1/api/tim-kiem?keyword=${encodeURIComponent(keyword)}&page=${page}&limit=${limit}`)
                .then(d => d?.data?.items || [])
                .catch(() => []),
            fetchJsonNguonc(`${API2}/films/search?keyword=${encodeURIComponent(keyword)}&page=${page}`)
                .then(d => d?.items || [])
                .catch(() => [])
        ]);

        /* đan xen 2 nguồn rồi khử trùng: gộp các bản cùng bộ phim (kể cả khác tên/season) */
        const merged = [];
        for (let i = 0; i < Math.max(kk.length, ng.length); i++) {
            if (i < kk.length) merged.push(kk[i]);
            if (i < ng.length) merged.push(normalizeNguoncItem(ng[i]));
        }
        const items = dedupeList(merged).slice(0, limit);

        res.set("Cache-Control", "public, max-age=300");
        res.json({
            items,
            paginate: { current_page: page, items_per_page: items.length, total_items: items.length }
        });
    } catch (error) {
        console.error("/api/search", error.message);
        res.status(502).json({ success: false, message: "Không tải được dữ liệu." });
    }
});

/* Danh sách tham chiếu */
listRoute("/api/categories", () => `${API}/the-loai`);
listRoute("/api/countries", () => `${API}/quoc-gia`);
listRoute("/api/years", () => `${API}/nam`);

/* ---------- Bộ lọc nâng cao + sắp xếp ---------- */
listRoute("/api/filter/:slug", q => {
    const p = new URLSearchParams({
        page: q.page,
        sort_field: q.sort_field || "modified.time",
        sort_type: q.sort_type || "desc"
    });
    if (q.category) p.set("category", q.category);
    if (q.country) p.set("country", q.country);
    if (q.year) p.set("year", q.year);
    if (q.lang) p.set("lang", q.lang);
    return `${API}/v1/api/danh-sach/${encodeURIComponent(q.slug)}?${p}`;
});

/* ---------- Chi tiết phim v1 (có seoOnPage) ---------- */
listRoute("/api/movie-v1/:slug", q =>
    `${API}/v1/api/phim/${encodeURIComponent(q.slug)}`
);

/* ---------- Chi tiết phim (bản gốc, đủ episodes) ---------- */
app.get("/api/movie/:slug", async (req, res) => {
    try {
        const data = await fetchJson(
            `${API}/phim/${encodeURIComponent(req.params.slug)}`
        );
        const item = data?.movie || data?.data?.item || data?.item || null;
        if (!item) {
            return res.status(404).json({ success: false, message: "Không tìm thấy phim." });
        }
        let episodes = data?.episodes || item.episodes || [];

        /* Chuẩn hóa link: một số server nguồn trả "Tập 01|https://...m3u8" */
        const cleanLink = u => {
            if (typeof u !== "string") return u;
            const i = u.lastIndexOf("|");
            if (i > 0) {
                const p = u.slice(i + 1).trim();
                if (/^https?:\/\//i.test(p)) return p;
            }
            return u.trim();
        };
        episodes.forEach(s => (s.server_data || []).forEach(ep => {
            if (ep.link_m3u8) ep.link_m3u8 = cleanLink(ep.link_m3u8);
            if (ep.link_embed) ep.link_embed = cleanLink(ep.link_embed);
        }));
        let fallback_error = null;
        let nguonc_ok = false;
        const jobs = [];
        if (!episodes.length) {
            jobs.push(
                fetchJson(`https://kkphim2.com/v1/api/phim/${encodeURIComponent(req.params.slug)}`)
                    .then(v1 => { episodes.push(...(v1?.episodes || v1?.data?.item?.episodes || [])); })
                    .catch(e => { fallback_error = "Không tải được danh sách tập từ nguồn dự phòng: " + e.message; console.error("detail-fallback", e.message); })
            );
        }
        jobs.push(mergeNguonc(req, episodes, item).then(ok => { nguonc_ok = ok; }));
        await Promise.all(jobs);
        const merged = mergeServersByLang(episodes);
        episodes.length = 0;
        episodes.push(...merged);
        res.set("Cache-Control", "public, max-age=300");
        res.json({
            success: true,
            movie: item,
            episodes,
            episodes_empty: !episodes.length,
            fallback_error,
            nguonc_merged: nguonc_ok,
            seo: data?.seoOnPage || data?.data?.seoOnPage || null
        });
    } catch (error) {
        console.error("detail", error.message);
        /* KKPhim không có phim này -> thử NGUỒN 2 (Nguonc) */
        try {
            const d2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(req.params.slug)}`);
            const m2 = d2?.movie;
            if (m2) {
                const eps2 = mergeServersByLang((m2.episodes || []).map(s => ({
                    server_name: s.server_name || "Server",
                    server_data: (s.items || []).map(ep => ({
                        name: ep.name || "",
                        slug: ep.slug || "",
                        link_m3u8: ep.m3u8 || "",
                        link_embed: ep.embed || ""
                    }))
                })));
                m2.origin_name = m2.original_name || m2.origin_name || "";
                m2.poster_url = m2.poster_url_webp || m2.poster_url || "";
                m2.thumb_url = m2.thumb_url_webp || m2.thumb_url || "";
                m2.episode_current = m2.current_episode || m2.episode_current || "";
                let cats2 = [];
                if (Array.isArray(m2.category)) cats2 = m2.category;
                else if (typeof m2.category === "string")
                    cats2 = m2.category.split(",").map(n => ({ name: n.trim() })).filter(c => c.name);
                m2.category = cats2;
                res.set("Cache-Control", "public, max-age=300");
                return res.json({
                    success: true,
                    movie: m2,
                    episodes: eps2,
                    episodes_empty: !eps2.length,
                    source: "nguonc"
                });
            }
        } catch (e2) {
            console.error("detail-nguonc", e2.message);
        }
        res.status(502).json({ success: false, message: "Không tải được phim." });
    }
});

/* Pretty URL: /phim/:slug -> movie.html */
app.get("/phim/:slug", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "movie.html"));
});

/* ---------- Nguồn 2 (Nguonc): chuẩn hóa về cùng dạng episodes của nguồn 1 ---------- */
function normalizeNguonc(movie2) {
    return (movie2?.episodes || []).map(s => ({
        server_name: `Nguonc • ${s.server_name || "Server"}`,
        server_data: (s.items || []).map(it => ({
            name: it.name,
            slug: it.slug,
            link_m3u8: it.m3u8 || "",
            link_embed: it.embed || ""
        })).filter(ep => ep.link_m3u8 || ep.link_embed)
    })).filter(s => s.server_data.length);
}

/* ---------- GỘP SERVER THEO NGÔN NGỮ (giảm rườm rà tabs) ---------- */
function normalizeLang(serverName) {
    const n = String(serverName || "").toLowerCase();
    if (/lồng ?tiếng|long ?tieng/.test(n)) return "Lồng Tiếng";
    if (/thuyết ?minh|thuyet ?minh/.test(n)) return "Thuyết Minh";
    if (/vietsub|vietsu/.test(n)) return "Vietsub";
    return (serverName || "Khác").trim();
}
/* Chuẩn hóa TÊN TẬP về dạng thống nhất "Tập 01", "Tập 100"... */
function formatEpName(rawName) {
    const s = String(rawName == null ? "" : rawName).trim();
    const m = s.match(/^(?:tập\s*)?(\d+)$/i);
    if (m) return "Tập " + String(parseInt(m[1], 10)).padStart(2, "0");
    return s;
}
function mergeServersByLang(all) {
    const map = new Map();
    for (const src of all) {
        const lang = normalizeLang(src.server_name);
        if (!map.has(lang)) map.set(lang, []);
        const bucket = map.get(lang);
        for (const ep of (src.server_data || [])) {
            const m3u8 = ep.link_m3u8 || "";
            const embeds = [];
            if (ep.link_embed) embeds.push(ep.link_embed);
            if (ep.embeds) embeds.push(...ep.embeds);
            if (!m3u8 && !embeds.length) continue;
            /* gộp theo SỐ TẬP ("Tập 01" của KKPhim = "1" của Nguonc) */
            const num = parseInt(String(ep.name || "").replace(/\D/g, ""), 10) || 0;
            const key = num || String(ep.name || "");
            let target = bucket.find(x => x._key === key);
            if (!target) {
                target = {
                    _key: key,
                    name: formatEpName(ep.name),
                    slug: ep.slug || ("tap-" + String(num).padStart(2, "0")),
                    link_m3u8: "", embeds: []
                };
                bucket.push(target);
            }
            if (m3u8 && !target.link_m3u8) target.link_m3u8 = m3u8;
            for (const e of embeds) if (!target.embeds.includes(e)) target.embeds.push(e);
        }
    }
    const out = [];
    for (const [lang, eps] of map) {
        eps.sort((a, b) => (parseInt(a._key, 10) || 0) - (parseInt(b._key, 10) || 0));
        for (const ep of eps) delete ep._key;
        out.push({ server_name: lang, server_data: eps });
    }
    const prio = { "Vietsub": 0, "Thuyết Minh": 1, "Lồng Tiếng": 2 };
    out.sort((a, b) => (prio[a.server_name] ?? 9) - (prio[b.server_name] ?? 9));
    return out;
}

/* Tìm bản song sinh trong kết quả search Nguonc: TMDB id trước, sau đó TÊN NỀN
   (baseKey — bỏ season/ngoặc/số) để bắt cùng bộ phim dù tên khác nhau. */
function findInNguoncSearch(found, item) {
    const type = item.tmdb?.type === "tv" || item.type === "series" ? "tv" : "movie";
    if (item.tmdb?.id) {
        const byTmdb = (found.items || []).find(x =>
            (x.tmdb?.id === item.tmdb.id) &&
            (type === "tv" ? true : x.tmdb?.type !== "tv"));
        if (byTmdb) return byTmdb;
    }
    const bk = baseKey(item);
    if (bk) {
        const byName = (found.items || []).find(x =>
            baseKey(x) === bk &&
            (type === "tv" ? true : x.tmdb?.type !== "tv"));
        if (byName) return byName;
    }
    return null;
}

/* Ghép server Nguonc vào kết quả chi tiết phim nguồn 1 (KKPhim).
   Đối chiếu 3 tầng: slug -> TMDB id -> TÊN NỀN/GỐC -> TÊN HIỂN THỊ.
   Nhờ đó khi người xem mở 1 thẻ (đã gộp 1 thẻ duy nhất ở danh sách),
   họ nhận được TOÀN BỘ server của CẢ HAI nguồn trong bảng chọn Server. */
async function mergeNguonc(req, episodes, item) {
    try {
        let m2 = null;
        try { m2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(req.params.slug)}`); }
        catch { /* slug không trùng — thử tiếp các tầng dưới */ }
        if (!m2?.movie && item?.tmdb?.id) {
            try {
                const found = await fetchJsonNguonc(
                    `${API2}/films/search?keyword=${encodeURIComponent(String(item.tmdb.id))}&page=1`
                );
                const hit = findInNguoncSearch(found, item);
                if (hit) m2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(hit.slug)}`);
            } catch { /* bỏ qua */ }
        }
        /* TÊN GỐC (origin_name): bắt bản song sinh mà TMDB của 1 trong 2 nguồn thiếu */
        if (!m2?.movie && item.origin_name) {
            try {
                const found = await fetchJsonNguonc(
                    `${API2}/films/search?keyword=${encodeURIComponent(item.origin_name)}&page=1`
                );
                const hit = findInNguoncSearch(found, item);
                if (hit) m2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(hit.slug)}`);
            } catch { /* bỏ qua */ }
        }
        /* TÊN HIỂN THỊ (name): nguồn 2 đôi khi chỉ có tên tiếng Việt */
        if (!m2?.movie && item.name && item.name !== item.origin_name) {
            try {
                const found = await fetchJsonNguonc(
                    `${API2}/films/search?keyword=${encodeURIComponent(item.name)}&page=1`
                );
                const hit = findInNguoncSearch(found, item);
                if (hit) m2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(hit.slug)}`);
            } catch { /* bỏ qua */ }
        }
        const extra = normalizeNguonc(m2?.movie);
        if (extra.length) episodes.push(...extra);
        /* Ảnh: Nguonc có ảnh webp đẹp hơn -> ưu tiên ảnh Nguonc cho trang chi tiết */
        if (m2?.movie) {
            const p2 = m2.movie.poster_url_webp || m2.movie.poster_url || "";
            const t2 = m2.movie.thumb_url_webp || m2.movie.thumb_url || "";
            if (p2) item.poster_url = p2;
            if (t2) item.thumb_url = t2;
        }
        return true;
    } catch (e) {
        console.error("merge-nguonc", e.message);
        return false;
    }
}

/* ---------- Thống kê tổng số phim (2 nguồn, trừ trùng theo slug) ---------- */
let statsCache = { t: 0, data: null };
app.get("/api/stats", async (req, res) => {
    if (statsCache.data && Date.now() - statsCache.t < 10 * 60 * 1000)
        return res.json(statsCache.data);
    try {
        const types = ["phim-le", "phim-bo", "hoat-hinh", "tv-shows"];
        const results = await Promise.all(types.map(async t => {
            const [kk, ng] = await Promise.all([
                fetchJson(`${API}/v1/api/danh-sach/${t}?page=1&limit=1`)
                    .then(d => d?.data?.params?.pagination?.totalItems || 0)
                    .catch(() => 0),
                fetchJsonNguonc(`${API2}/films/danh-sach/${t}?page=1`)
                    .then(d => d?.paginate?.total_items || 0)
                    .catch(() => 0)
            ]);
            return { type: t, kk, ng };
        }));
        const dupRate = await (async () => {
            try {
                const samples = await Promise.all(types.map(async t => {
                    const [kk, ng] = await Promise.all([
                        fetchJson(`${API}/v1/api/danh-sach/${t}?page=1&limit=90`)
                            .then(d => (d?.data?.items || []).map(x => x.slug))
                            .catch(() => []),
                        fetchJsonNguonc(`${API2}/films/danh-sach/${t}?page=1`)
                            .then(d => (d?.items || []).map(x => x.slug))
                            .catch(() => [])
                    ]);
                    const setK = new Set(kk);
                    const overlap = ng.filter(s => setK.has(s)).length;
                    return overlap / Math.max(1, Math.min(kk.length, ng.length));
                }));
                const avg = samples.filter(x => x > 0);
                return avg.length ? avg.reduce((a, b) => a + b, 0) / avg.length : 0;
            } catch { return 0; }
        })();
        const sumKK = results.reduce((a, r) => a + r.kk, 0);
        const sumNG = results.reduce((a, r) => a + r.ng, 0);
        const dup = Math.round(Math.min(sumKK, sumNG) * dupRate);
        const data = {
            total: sumKK + sumNG - dup,
            source1: sumKK,
            source2: sumNG,
            duplicates: dup,
            updated: new Date().toISOString()
        };
        statsCache = { t: Date.now(), data };
        res.json(data);
    } catch (e) {
        console.error("stats", e.message);
        res.status(502).json({ success: false });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Filmlo running on http://localhost:${PORT}`);
});

/* Graceful shutdown — Railway gửi SIGTERM khi redeploy */
process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
});
