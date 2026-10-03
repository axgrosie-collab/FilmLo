﻿/**
 * Filmlo â€” proxy cho phimapi.com (KKPhim API)
 * Deploy Railway: npm start (PORT do Railway cáº¥p)
 */

const express = require("express");
const compression = require("compression");
const path = require("path");

const app = express();

/* Railway cháº¡y sau proxy -> tin Ä‘á»‹a chá»‰ IP cá»§a client */
app.set("trust proxy", 1);

/* Nguá»“n 2 (Nguonc) â€” xem NGUONC_GATEWAYS bÃªn dÆ°á»›i (dÃ²ng ~150):
   tá»± chá»n Ä‘Æ°á»ng Ä‘i (tháº³ng/proxy) khi bá»‹ cháº·n IP data center nÆ°á»›c ngoÃ i. */
const PORT = process.env.PORT || 3000;
const API = "https://phimapi.com";

/* ---------- Log truy cáº­p (xem trÃªn Railway: Deployments â†’ Logs) ---------- */
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
        /* bá» qua healthcheck Ä‘á»ƒ log Ä‘á»¡ nhiá»…u */
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

/* NÃ©n gzip má»i response (HTML/JSON náº·ng -> nhá» hÆ¡n 5-10 láº§n) */
app.use(compression());

/* Static: HTML khÃ´ng cache (deploy má»›i cÃ³ hiá»‡u lá»±c ngay), JS lib cache lÃ¢u */
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
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/* ---------- Thá»‘ng kÃª tá»•ng sá»‘ phim (2 nguá»“n, trá»« trÃ¹ng theo slug) ----------
   Nguá»“n 1 (KKPhim): tá»•ng 4 loáº¡i phim-le/phim-bo/hoat-hinh/tv-shows (tá»« params.pagination)
   Nguá»“n 2 (Nguonc): tá»•ng tá»« paginate.total_items cá»§a tá»«ng loáº¡i
   Phim trÃ¹ng giá»¯a 2 nguá»“n: Ä‘á»‘i chiáº¿u qua slug â€” nhÆ°ng Ä‘á»ƒ tÃ­nh chÃ­nh xÃ¡c
   khÃ´ng cáº§n táº£i háº¿t, dÃ¹ng cÃ´ng thá»©c: KK + Nguonc - trÃ¹ng (Æ°á»›c lÆ°á»£ng báº±ng
   tá»‰ lá»‡ trÃ¹ng láº¥y tá»« máº«u Ä‘á»‘i chiáº¿u trang Ä‘áº§u má»—i nguá»“n). */
let statsCache = { t: 0, data: null };
app.get("/api/stats", async (req, res) => {
    if (statsCache.data && Date.now() - statsCache.t < 10 * 60 * 1000)
        return res.json(statsCache.data);
    try {
        /* tá»•ng má»—i nguá»“n theo tá»«ng loáº¡i (phim-le, phim-bo, hoat-hinh, tv-shows) */
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
        /* Æ¯á»›c lÆ°á»£ng trÃ¹ng: láº¥y máº«u slug trang 1 (limit 90 cá»§a KK, 10 cá»§a Nguonc)
           theo tá»«ng loáº¡i -> tá»‰ lá»‡ trÃ¹ng trung bÃ¬nh, Ã¡p lÃªn tá»•ng */
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

/* ---------- Cache in-memory (TTL 5 phÃºt) ---------- */

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

/* ---------- Helper fetch chung ---------- */

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

/* ---------- Nguonc gateway: tá»± chá»n Ä‘Æ°á»ng Ä‘i khi bá»‹ cháº·n ----------
   Nguonc (server VN + Cloudflare) cháº·n IP data center nÆ°á»›c ngoÃ i -> Railway
   gá»i tháº³ng bá»‹ 403/timeout. Fix: thá»­ DANH SÃCH GATEWAY theo thá»© tá»±:
   [proxy riÃªng] -> [gá»i tháº³ng] -> cÃ¡c proxy trung gian cÃ´ng cá»™ng. Gateway nÃ o
   thÃ nh cÃ´ng Ä‘Æ°á»£c NHá»š (nguoncGateway) dÃ¹ng cho cÃ¡c request sau. á»ž mÃ¡y local VN
   gá»i tháº³ng thÃ nh cÃ´ng ngay -> khÃ´ng bao giá» cháº¡m proxy. */
const NGUONC_ORIG = "https://phim.nguonc.com/api";
/* API2 = phần đầu (base) của URL Nguonc. Mặc định là origin gốc; nếu có biến
   NGUONC_PROXY thì dùng proxy đó làm base ( Railway: set NGUONC_PROXY nếu cần). */
const API2 = process.env.NGUONC_PROXY
    ? `${String(process.env.NGUONC_PROXY).replace(/\/+$/, "")}/api`
    : NGUONC_ORIG;
const NGUONC_GATEWAYS = [
    (u) => u,                                                           // goi thang (nhanh nhat, local VN OK)
    ...(API2 ? [(u) => `${API2}${u.slice(NGUONC_ORIG.length)}`] : []),  // proxy rieng neu cau hinh
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://cors.eu.org/${u}`,
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
];
let nguoncGateway = -1;   // index Ä‘ang dÃ¹ng (-1 = chÆ°a biáº¿t, auto-detect)

async function fetchJsonNguonc(url, depth = 0) {
    if (depth >= NGUONC_GATEWAYS.length)
        throw new Error("Nguonc: táº¥t cáº£ gateway Ä‘á»u tháº¥t báº¡i");
    const idx = depth === 0 && nguoncGateway >= 0 ? nguoncGateway : depth;
    const target = NGUONC_GATEWAYS[idx](url);
    try {
        const cached = cacheGet(target);
        if (cached) return cached;
        const response = await fetch(target, {
            /* Cloudflare của Nguonc chặn UA không phải trình duyệt (vd "Filmlo/1.0")
               → dùng UA trình duyệt thật như khi ta mở trang web */
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Upgrade-Insecure-Requests": "1"
            },
            signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        cacheSet(target, data);
        if (idx !== nguoncGateway) {
            nguoncGateway = idx;   // nhá»› gateway thÃ nh cÃ´ng cho cÃ¡c láº§n sau
            console.log(`nguonc gateway #${idx} hoáº¡t Ä‘á»™ng${idx > 1 ? " (qua proxy)" : ""}`);
        }
        return data;
    } catch (e) {
        console.error(`nguonc gateway #${idx} FAIL: ${e.message}`);
        if (depth === 0) { nguoncGateway = -1; }   // reset, tá»± dÃ² láº¡i gateway
        return fetchJsonNguonc(url, depth + 1);
    }
}

/* Chuáº©n hÃ³a 1 item Nguonc vá» cÃ¹ng shape field nhÆ° KKPhim Ä‘á»ƒ frontend dÃ¹ng chung
   (name, origin_name, poster_url, thumb_url, episode_current, quality, category) */
function normalizeNguoncItem(m) {
    if (!m) return null;
    /* Nguonc tráº£ category lÃ  chuá»—i "HÃ nh Äá»™ng, PhiÃªu LÆ°u" -> tÃ¡ch thÃ nh máº£ng {name} */
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

/* ---------- Route factory: gom toÃ n bá»™ endpoint danh sÃ¡ch ---------- */

function listRoute(path, buildUrl) {
    app.get(path, async (req, res) => {
        try {
            const q = { ...req.params, ...(req.query || {}) };
            const page = Math.max(1, Number(q.page) || 1);
            const data = await fetchJson(buildUrl({ ...q, page }));
            res.set("Cache-Control", "public, max-age=300");
            res.json(data);
        } catch (error) {
            console.error(path, error.message);
            res.status(502).json({ success: false, message: "KhÃ´ng táº£i Ä‘Æ°á»£c dá»¯ liá»‡u." });
        }
    });
}

/* Phim má»›i cáº­p nháº­t â€” dÃ¹ng NGUá»’N 1 (KKPhim) cho Äá»’NG Bá»˜ áº£nh vá»›i cÃ¡c tab khÃ¡c
   (Phim láº» / Phim bá»™ / Hoáº¡t hÃ¬nh... Ä‘á»u lÃ  áº£nh KKPhim cháº¥t lÆ°á»£ng cao ~68KB,
   cÃ²n áº£nh Nguonc chá»‰ ~19KB -> trÃ´ng má» hÆ¡n háº³n trÃªn card).
   Äá»•i trang chá»§ vá» KKPhim Ä‘á»ƒ áº£nh Ä‘á»“ng nháº¥t, nÃ©t Ä‘áº¹p nhÆ° cÃ¡c tab cÃ²n láº¡i. */
app.get("/api/movies", async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const data = await fetchJson(
            `${API}/v1/api/danh-sach/phim-moi-cap-nhat?page=${page}&limit=20`
        );
        const items = data?.items || data?.data?.items || [];
        const paginate = data?.data?.paginate || data?.paginate || null;
        res.set("Cache-Control", "public, max-age=300");
        res.json({ items, paginate });
    } catch (error) {
        console.error("/api/movies", error.message);
        res.status(502).json({ success: false, message: "KhÃ´ng táº£i Ä‘Æ°á»£c dá»¯ liá»‡u." });
    }
});

/* Danh sÃ¡ch theo loáº¡i: phim-bo, phim-le, tv-shows, hoat-hinh */
listRoute("/api/list/:slug", q =>
    `${API}/v1/api/danh-sach/${encodeURIComponent(q.slug)}?page=${q.page}&limit=48`
);

/* Theo thá»ƒ loáº¡i */
listRoute("/api/category/:slug", q =>
    `${API}/v1/api/the-loai/${encodeURIComponent(q.slug)}?page=${q.page}&limit=48`
);

/* Theo quá»‘c gia */
listRoute("/api/country/:slug", q =>
    `${API}/v1/api/quoc-gia/${encodeURIComponent(q.slug)}?page=${q.page}&limit=48`
);

/* Theo nÄƒm */
listRoute("/api/year/:year", q =>
    `${API}/v1/api/nam/${encodeURIComponent(q.year)}?page=${q.page}&limit=48`
);

/* KhÃ³a khá»­ trÃ¹ng cho 1 phim: slug + tÃªn gá»‘c (bá» dáº¥u, khoáº£ng tráº¯ng, kÃ½ tá»± Ä‘áº·c biá»‡t).
   CÃ¹ng má»™t phim á»Ÿ 2 nguá»“n thÆ°á»ng cÃ³ slug khÃ¡c nhau (vd "bo-lan-huong-nhu-co" vs
   "lan-huong-nhu-co") nhÆ°ng tÃªn gá»‘c trÃ¹ng khá»›p -> gá»™p láº¡i thÃ nh 1 káº¿t quáº£. */
function dedupeKey(m) {
    const norm = s => String(s || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // bo dau tieng Viet
        .replace(/[^a-z0-9]/g, "");               // chá»‰ giá»¯ chá»¯ + sá»‘
    const a = norm(m.name), b = norm(m.origin_name);
    return [norm(m.slug), a, b].filter(Boolean).join("|");
}

/* ---------- TÃ¬m kiáº¿m: Gá»˜P 2 NGUá»’N (KKPhim + Nguonc) ----------
   TrÆ°á»›c Ä‘Ã¢y /api/search CHá»ˆ tÃ¬m á»Ÿ KKPhim -> phim chá»‰ cÃ³ á»Ÿ nguá»“n 2 (VD "Tháº¿ Giá»›i
   PhÃ©p Thuáº­t 2" = Black Clover) hiá»‡n trÃªn trang chá»§ nhÆ°ng tÃ¬m khÃ´ng ra.
   Káº¿t quáº£ 2 nguá»“n Ä‘Æ°á»£c ÄAN XEN (round-robin) rá»“i trá»« trÃ¹ng theo slug, nhá» váº­y
   phim chá»‰ cÃ³ á»Ÿ nguá»“n 2 váº«n náº±m sá»›m trong danh sÃ¡ch káº¿t quáº£ vÃ  cáº£ gá»£i Ã½. */
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

        /* Ä‘an xen kk[0], ng[0], kk[1], ng[1], ... -> 2 nguá»“n cÃ¹ng xuáº¥t hiá»‡n.
           Khá»­ trÃ¹ng theo dedupeKey: cÃ¹ng 1 phim á»Ÿ 2 nguá»“n (slug khÃ¡c nhau nhÆ°ng
           tÃªn gá»‘c trÃ¹ng) chá»‰ giá»¯ láº¡i 1 báº£n â€” Æ°u tiÃªn báº£n Nguonc vÃ¬ áº£nh Ä‘áº¹p hÆ¡n. */
        const merged = [];
        for (let i = 0; i < Math.max(kk.length, ng.length); i++) {
            if (i < kk.length) merged.push(kk[i]);
            if (i < ng.length) merged.push(normalizeNguoncItem(ng[i]));
        }
        const seen = new Map();           // dedupeKey -> index trong items
        const items = [];
        for (const m of merged) {
            if (!m) continue;
            const s = m.slug || m.name;
            if (!s) continue;
            const key = dedupeKey(m);
            if (seen.has(key)) {
                /* trÃ¹ng: giá»¯ báº£n Nguonc (áº£nh webp Ä‘áº¹p hÆ¡n) */
                const prev = items[seen.get(key)];
                if (m._nguonc && !prev._nguonc) items[seen.get(key)] = m;
                continue;
            }
            seen.set(key, items.length);
            items.push(m);
        }
        items.length = Math.min(items.length, limit);

        res.set("Cache-Control", "public, max-age=300");
        res.json({
            items,
            paginate: { current_page: page, items_per_page: items.length, total_items: items.length }
        });
    } catch (error) {
        console.error("/api/search", error.message);
        res.status(502).json({ success: false, message: "KhÃ´ng táº£i Ä‘Æ°á»£c dá»¯ liá»‡u." });
    }
});

/* Danh sÃ¡ch tham chiáº¿u */
listRoute("/api/categories", () => `${API}/the-loai`);
listRoute("/api/countries", () => `${API}/quoc-gia`);
listRoute("/api/years", () => `${API}/nam`);

/* ---------- Bá»™ lá»c nÃ¢ng cao + sáº¯p xáº¿p ----------
   Params: slug (phim-bo/phim-le/tv-shows/hoat-hinh), sort_field,
   sort_type, category, country, year, lang, page */
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

/* ---------- Chi tiáº¿t phim v1 (cÃ³ seoOnPage) ---------- */
listRoute("/api/movie-v1/:slug", q =>
    `${API}/v1/api/phim/${encodeURIComponent(q.slug)}`
);

/* ---------- Chi tiáº¿t phim (báº£n gá»‘c, Ä‘á»§ episodes) ---------- */
app.get("/api/movie/:slug", async (req, res) => {
    try {
        const data = await fetchJson(
            `${API}/phim/${encodeURIComponent(req.params.slug)}`
        );
        // Chuáº©n hÃ³a: API tráº£ vá» { status, data: { item, seoOnPage,... } }
        // -> tráº£ vá» { movie, episodes } Ä‘á»ƒ frontend dÃ¹ng thá»‘ng nháº¥t
        const item = data?.movie || data?.data?.item || data?.item || null;
        if (!item) {
            return res.status(404).json({ success: false, message: "KhÃ´ng tÃ¬m tháº¥y phim." });
        }
        // episodes á»Ÿ top-level (báº£n gá»‘c) hoáº·c trong item (v1)
        let episodes = data?.episodes || item.episodes || [];

        /* Chuáº©n hÃ³a link: má»™t sá»‘ server nguá»“n tráº£ "Táº­p 01|https://...m3u8"
           (tÃªn táº­p + url ná»‘i báº±ng |) -> cáº¯t bá» prefix, chá»‰ giá»¯ URL. */
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
        /* GhÃ©p thÃªm server tá»« nguá»“n 2 (Nguonc) â€” cháº¡y SONG SONG vá»›i fallback
           Ä‘á»ƒ tá»•ng thá»i gian pháº£n há»“i khÃ´ng tÄƒng (Promise.all). */
        let fallback_error = null;
        let nguonc_ok = false;
        const jobs = [];
        if (!episodes.length) {
            jobs.push(
                fetchJson(`https://kkphim2.com/v1/api/phim/${encodeURIComponent(req.params.slug)}`)
                    .then(v1 => { episodes.push(...(v1?.episodes || v1?.data?.item?.episodes || [])); })
                    .catch(e => { fallback_error = "KhÃ´ng táº£i Ä‘Æ°á»£c danh sÃ¡ch táº­p tá»« nguá»“n dá»± phÃ²ng: " + e.message; console.error("detail-fallback", e.message); })
            );
        }
        jobs.push(mergeNguonc(req, episodes, item).then(ok => { nguonc_ok = ok; }));
        await Promise.all(jobs);
        /* Gá»™p táº¥t cáº£ server (KKPhim + Nguonc) theo ngÃ´n ngá»¯ -> chá»‰ cÃ²n 2â€“3 tab,
           má»—i táº­p gá»™p nhiá»u luá»“ng (m3u8 + embed) Ä‘á»ƒ frontend Ä‘á»•i server */
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
        /* KKPhim khÃ´ng cÃ³ phim nÃ y -> thá»­ NGUá»’N 2 (Nguonc)
           (phim trÃªn trang chá»§ lÃ  dá»¯ liá»‡u Nguonc nÃªn slug chá»‰ tá»“n táº¡i á»Ÿ Nguonc) */
        try {
            const d2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(req.params.slug)}`);
            const m2 = d2?.movie;
            if (m2) {
                /* chuáº©n hÃ³a tÃªn táº­p ("1" -> "Táº­p 01") + gá»™p server theo ngÃ´n ngá»¯= dÃ¹ng
                   CHUNG mergeServersByLang vá»›i nhÃ¡nh KKPhim Ä‘á»ƒ hiá»ƒn thá»‹ Ä‘á»“ng nháº¥t */
                const eps2 = mergeServersByLang((m2.episodes || []).map(s => ({
                    server_name: s.server_name || "Server",
                    server_data: (s.items || []).map(ep => ({
                        name: ep.name || "",
                        slug: ep.slug || "",
                        link_m3u8: ep.m3u8 || "",
                        link_embed: ep.embed || ""
                    }))
                })));
                /* chuáº©n hÃ³a field vá» dáº¡ng KKPhim Ä‘á»ƒ frontend dÃ¹ng chung */
                m2.origin_name = m2.original_name || m2.origin_name || "";
                m2.poster_url = m2.poster_url_webp || m2.poster_url || "";
                m2.thumb_url = m2.thumb_url_webp || m2.thumb_url || "";
                m2.episode_current = m2.current_episode || m2.episode_current || "";
                /* Nguonc tráº£ category lÃ  chuá»—i "HÃ nh Äá»™ng, PhiÃªu LÆ°u" -> tÃ¡ch thÃ nh máº£ng {name} */
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
        res.status(502).json({ success: false, message: "KhÃ´ng táº£i Ä‘Æ°á»£c phim." });
    }
});

/* Pretty URL: /phim/:slug -> movie.html */
app.get("/phim/:slug", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "movie.html"));
});

/* ---------- Nguá»“n 2 (Nguonc): chuáº©n hÃ³a vá» cÃ¹ng dáº¡ng episodes cá»§a nguá»“n 1 ----------
   movie.episodes = [{ server_name, items: [{ name, slug, embed, m3u8? }] }]
   -> [{ server_name: "Nguonc â€¢ Vietsub #1", server_data: [{ name, slug, link_embed, link_m3u8? }] }] */
function normalizeNguonc(movie2) {
    return (movie2?.episodes || []).map(s => ({
        server_name: `Nguonc â€¢ ${s.server_name || "Server"}`,
        server_data: (s.items || []).map(it => ({
            name: it.name,
            slug: it.slug,
            /* m3u8 Æ°u tiÃªn; má»™t sá»‘ nguá»“n tráº£ field "m3u8" trá»±c tiáº¿p */
            link_m3u8: it.m3u8 || "",
            link_embed: it.embed || ""
        })).filter(ep => ep.link_m3u8 || ep.link_embed)
    })).filter(s => s.server_data.length);
}

/* ---------- Gá»˜P SERVER THEO NGÃ”N NGá»® (giáº£m rÆ°á»m rÃ  tabs) ----------
   Cáº£ 2 nguá»“n (KKPhim + Nguonc) gom vá» dáº¡ng:
   { server_name: "Vietsub", server_data: [{ name, slug, link_m3u8, embeds: [url...] }] }
   â€” má»—i táº­p cÃ³ thá»ƒ cÃ³ nhiá»u luá»“ng (m3u8 + embed cá»§a tá»«ng nguá»“n);
   frontend sáº½ hiá»ƒn thá»‹ "Server 1/2/3..." Ä‘á»ƒ Ä‘á»•i luá»“ng, Æ°u tiÃªn m3u8. */
function normalizeLang(serverName) {
    const n = String(serverName || "").toLowerCase();
    if (/lá»“ng ?tiáº¿ng|long ?tieng/.test(n)) return "Lá»“ng Tiáº¿ng";
    if (/thuyáº¿t ?minh|thuyet ?minh/.test(n)) return "Thuyáº¿t Minh";
    if (/vietsub|vietsu/.test(n)) return "Vietsub";
    return (serverName || "KhÃ¡c").trim();
}
/* Chuáº©n hÃ³a TÃŠN Táº¬P vá» dáº¡ng thá»‘ng nháº¥t "Táº­p 01", "Táº­p 100"... (Ä‘á»‡m 0 cho 2 chá»¯ sá»‘).
   Chá»‰ Ä‘á»•i khi tÃªn lÃ  Sá» thuáº§n ("1", "01") hoáº·c Ä‘Ã£ á»Ÿ dáº¡ng "Táº­p N"
   -> giá»¯ nguyÃªn tÃªn Ä‘áº·c biá»‡t: "Full", "HoÃ n Táº¥t (13/13)", "Táº­p Ä‘áº·c biá»‡t"... */
function formatEpName(rawName) {
    const s = String(rawName == null ? "" : rawName).trim();
    const m = s.match(/^(?:táº­p\s*)?(\d+)$/i);
    if (m) return "Táº­p " + String(parseInt(m[1], 10)).padStart(2, "0");
    return s;
}
function mergeServersByLang(all) {
    const map = new Map();
    for (const src of all) {
        const lang = normalizeLang(src.server_name);
        if (!map.has(lang)) map.set(lang, []);
        const bucket = map.get(lang);
        for (const ep of (src.server_data || [])) {
            /* KKPhim tráº£ link_m3u8 + link_embed; Nguonc tráº£ link_embed (+link_m3u8 náº¿u cÃ³) */
            const m3u8 = ep.link_m3u8 || "";
            const embeds = [];
            if (ep.link_embed) embeds.push(ep.link_embed);
            if (ep.embeds) embeds.push(...ep.embeds);
            if (!m3u8 && !embeds.length) continue;
            /* gá»™p theo Sá» Táº¬P (khÃ´ng phá»¥ thuá»™c tÃªn â€” "Táº­p 01" cá»§a KKPhim = "1" cá»§a Nguonc);
               tÃªn hiá»ƒn thá»‹ chuáº©n hÃ³a qua formatEpName() -> luÃ´n dáº¡ng "Táº­p 01" */
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
    /* sáº¯p xáº¿p táº­p theo sá»‘ tÄƒng dáº§n; bá» key ná»™i bá»™ trÆ°á»›c khi tráº£ vá» */
    const out = [];
    for (const [lang, eps] of map) {
        eps.sort((a, b) => (parseInt(a._key, 10) || 0) - (parseInt(b._key, 10) || 0));
        for (const ep of eps) delete ep._key;
        out.push({ server_name: lang, server_data: eps });
    }
    /* thá»© tá»± Æ°u tiÃªn: Vietsub > Thuyáº¿t Minh > Lá»“ng Tiáº¿ng > cÃ²n láº¡i */
    const prio = { "Vietsub": 0, "Thuyáº¿t Minh": 1, "Lá»“ng Tiáº¿ng": 2 };
    out.sort((a, b) => (prio[a.server_name] ?? 9) - (prio[b.server_name] ?? 9));
    return out;
}

/* GhÃ©p server Nguonc vÃ o káº¿t quáº£ chi tiáº¿t phim nguá»“n 1 (KKPhim).
   Äá»‘i chiáº¿u phim báº±ng slug -> náº¿u khÃ´ng tháº¥y, thá»­ TMDB id + loáº¡i phim. */
async function mergeNguonc(req, episodes, item) {
    try {
        let m2 = null;
        try { m2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(req.params.slug)}`); }
        catch { /* slug khÃ´ng trÃ¹ng â€” thá»­ tiáº¿p theo TMDB */ }
        if (!m2?.movie && item?.tmdb?.id) {
            const type = item.tmdb.type === "tv" || item.type === "series" ? "tv" : "movie";
            try {
                const found = await fetchJson(
                    `${API2}/films/search?keyword=${encodeURIComponent(String(item.tmdb.id))}&page=1`
                );
                const hit = (found.items || []).find(x =>
                    (x.tmdb?.id === item.tmdb.id) &&
                    (type === "tv" ? true : x.tmdb?.type !== "tv"));
                if (hit) m2 = await fetchJsonNguonc(`${API2}/film/${encodeURIComponent(hit.slug)}`);
            } catch { /* bá» qua */ }
        }
        const extra = normalizeNguonc(m2?.movie);
        if (extra.length) episodes.push(...extra);
        /* áº¢nh: Nguonc (nguá»“n 2) cÃ³ áº£nh webp Ä‘áº¹p hÆ¡n -> Æ°u tiÃªn dÃ¹ng áº£nh Nguonc
           Ä‘á»ƒ trang chi tiáº¿t giá»‘ng há»‡t áº£nh Ä‘Ã£ tháº¥y trÃªn trang chá»§ (cÅ©ng lÃ  Nguonc).
           Chá»‰ dÃ¹ng áº£nh KKPhim khi Nguonc khÃ´ng cÃ³ (trÃ¡nh áº£nh trá»‘ng). */
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

const server = app.listen(PORT, () => {
    console.log(`Filmlo running on http://localhost:${PORT}`);
});

/* Graceful shutdown â€” Railway gá»­i SIGTERM khi redeploy */
process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
});
