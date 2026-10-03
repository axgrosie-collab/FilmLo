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
const API2 = "https://phim.nguonc.com/api";   // nguồn 2 (Nguonc)

/* ---------- Log truy cập (xem trên Railway: Deployments → Logs) ---------- */
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
        /* bỏ qua healthcheck để log đỡ nhiễu */
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
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/* ---------- Thống kê tổng số phim (2 nguồn, trừ trùng theo slug) ----------
   Nguồn 1 (KKPhim): tổng 4 loại phim-le/phim-bo/hoat-hinh/tv-shows (từ params.pagination)
   Nguồn 2 (Nguonc): tổng từ paginate.total_items của từng loại
   Phim trùng giữa 2 nguồn: đối chiếu qua slug — nhưng để tính chính xác
   không cần tải hết, dùng công thức: KK + Nguonc - trùng (ước lượng bằng
   tỉ lệ trùng lấy từ mẫu đối chiếu trang đầu mỗi nguồn). */
let statsCache = { t: 0, data: null };
app.get("/api/stats", async (req, res) => {
    if (statsCache.data && Date.now() - statsCache.t < 10 * 60 * 1000)
        return res.json(statsCache.data);
    try {
        /* tổng mỗi nguồn theo từng loại (phim-le, phim-bo, hoat-hinh, tv-shows) */
        const types = ["phim-le", "phim-bo", "hoat-hinh", "tv-shows"];
        const results = await Promise.all(types.map(async t => {
            const [kk, ng] = await Promise.all([
                fetchJson(`${API}/v1/api/danh-sach/${t}?page=1&limit=1`)
                    .then(d => d?.data?.params?.pagination?.totalItems || 0)
                    .catch(() => 0),
                fetchJson(`${API2}/films/danh-sach/${t}?page=1`)
                    .then(d => d?.paginate?.total_items || 0)
                    .catch(() => 0)
            ]);
            return { type: t, kk, ng };
        }));
        /* Ước lượng trùng: lấy mẫu slug trang 1 (limit 90 của KK, 10 của Nguonc)
           theo từng loại -> tỉ lệ trùng trung bình, áp lên tổng */
        const dupRate = await (async () => {
            try {
                const samples = await Promise.all(types.map(async t => {
                    const [kk, ng] = await Promise.all([
                        fetchJson(`${API}/v1/api/danh-sach/${t}?page=1&limit=90`)
                            .then(d => (d?.data?.items || []).map(x => x.slug))
                            .catch(() => []),
                        fetchJson(`${API2}/films/danh-sach/${t}?page=1`)
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

/* Chuẩn hóa 1 item Nguonc về cùng shape field như KKPhim để frontend dùng chung
   (name, origin_name, poster_url, thumb_url, episode_current, quality, category) */
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
            res.set("Cache-Control", "public, max-age=300");
            res.json(data);
        } catch (error) {
            console.error(path, error.message);
            res.status(502).json({ success: false, message: "Không tải được dữ liệu." });
        }
    });
}

/* Phim mới cập nhật — dùng NGUỒN 1 (KKPhim) cho ĐỒNG BỘ ảnh với các tab khác
   (Phim lẻ / Phim bộ / Hoạt hình... đều là ảnh KKPhim chất lượng cao ~68KB,
   còn ảnh Nguonc chỉ ~19KB -> trông mờ hơn hẳn trên card).
   Đổi trang chủ về KKPhim để ảnh đồng nhất, nét đẹp như các tab còn lại. */
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

/* Khóa khử trùng cho 1 phim: slug + tên gốc (bỏ dấu, khoảng trắng, ký tự đặc biệt).
   Cùng một phim ở 2 nguồn thường có slug khác nhau (vd "bo-lan-huong-nhu-co" vs
   "lan-huong-nhu-co") nhưng tên gốc trùng khớp -> gộp lại thành 1 kết quả. */
function dedupeKey(m) {
    const norm = s => String(s || "").toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")   // bỏ dấu tiếng Việt
        .replace(/[^a-z0-9]/g, "");               // chỉ giữ chữ + số
    const a = norm(m.name), b = norm(m.origin_name);
    return [norm(m.slug), a, b].filter(Boolean).join("|");
}

/* ---------- Tìm kiếm: GỘP 2 NGUỒN (KKPhim + Nguonc) ----------
   Trước đây /api/search CHỈ tìm ở KKPhim -> phim chỉ có ở nguồn 2 (VD "Thế Giới
   Phép Thuật 2" = Black Clover) hiện trên trang chủ nhưng tìm không ra.
   Kết quả 2 nguồn được ĐAN XEN (round-robin) rồi trừ trùng theo slug, nhờ vậy
   phim chỉ có ở nguồn 2 vẫn nằm sớm trong danh sách kết quả và cả gợi ý. */
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
            fetchJson(`${API2}/films/search?keyword=${encodeURIComponent(keyword)}&page=${page}`)
                .then(d => d?.items || [])
                .catch(() => [])
        ]);

        /* đan xen kk[0], ng[0], kk[1], ng[1], ... -> 2 nguồn cùng xuất hiện.
           Khử trùng theo dedupeKey: cùng 1 phim ở 2 nguồn (slug khác nhau nhưng
           tên gốc trùng) chỉ giữ lại 1 bản — ưu tiên bản Nguonc vì ảnh đẹp hơn. */
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
                /* trùng: giữ bản Nguonc (ảnh webp đẹp hơn) */
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
        res.status(502).json({ success: false, message: "Không tải được dữ liệu." });
    }
});

/* Danh sách tham chiếu */
listRoute("/api/categories", () => `${API}/the-loai`);
listRoute("/api/countries", () => `${API}/quoc-gia`);
listRoute("/api/years", () => `${API}/nam`);

/* ---------- Bộ lọc nâng cao + sắp xếp ----------
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
        // Chuẩn hóa: API trả về { status, data: { item, seoOnPage,... } }
        // -> trả về { movie, episodes } để frontend dùng thống nhất
        const item = data?.movie || data?.data?.item || data?.item || null;
        if (!item) {
            return res.status(404).json({ success: false, message: "Không tìm thấy phim." });
        }
        // episodes ở top-level (bản gốc) hoặc trong item (v1)
        let episodes = data?.episodes || item.episodes || [];

        /* Chuẩn hóa link: một số server nguồn trả "Tập 01|https://...m3u8"
           (tên tập + url nối bằng |) -> cắt bỏ prefix, chỉ giữ URL. */
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
        /* Ghép thêm server từ nguồn 2 (Nguonc) — chạy SONG SONG với fallback
           để tổng thời gian phản hồi không tăng (Promise.all). */
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
        /* Gộp tất cả server (KKPhim + Nguonc) theo ngôn ngữ -> chỉ còn 2–3 tab,
           mỗi tập gộp nhiều luồng (m3u8 + embed) để frontend đổi server */
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
        /* KKPhim không có phim này -> thử NGUỒN 2 (Nguonc)
           (phim trên trang chủ là dữ liệu Nguonc nên slug chỉ tồn tại ở Nguonc) */
        try {
            const d2 = await fetchJson(`${API2}/film/${encodeURIComponent(req.params.slug)}`);
            const m2 = d2?.movie;
            if (m2) {
                /* chuẩn hóa tên tập ("1" -> "Tập 01") + gộp server theo ngôn ngữ= dùng
                   CHUNG mergeServersByLang với nhánh KKPhim để hiển thị đồng nhất */
                const eps2 = mergeServersByLang((m2.episodes || []).map(s => ({
                    server_name: s.server_name || "Server",
                    server_data: (s.items || []).map(ep => ({
                        name: ep.name || "",
                        slug: ep.slug || "",
                        link_m3u8: ep.m3u8 || "",
                        link_embed: ep.embed || ""
                    }))
                })));
                /* chuẩn hóa field về dạng KKPhim để frontend dùng chung */
                m2.origin_name = m2.original_name || m2.origin_name || "";
                m2.poster_url = m2.poster_url_webp || m2.poster_url || "";
                m2.thumb_url = m2.thumb_url_webp || m2.thumb_url || "";
                m2.episode_current = m2.current_episode || m2.episode_current || "";
                /* Nguonc trả category là chuỗi "Hành Động, Phiêu Lưu" -> tách thành mảng {name} */
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

/* ---------- Nguồn 2 (Nguonc): chuẩn hóa về cùng dạng episodes của nguồn 1 ----------
   movie.episodes = [{ server_name, items: [{ name, slug, embed, m3u8? }] }]
   -> [{ server_name: "Nguonc • Vietsub #1", server_data: [{ name, slug, link_embed, link_m3u8? }] }] */
function normalizeNguonc(movie2) {
    return (movie2?.episodes || []).map(s => ({
        server_name: `Nguonc • ${s.server_name || "Server"}`,
        server_data: (s.items || []).map(it => ({
            name: it.name,
            slug: it.slug,
            /* m3u8 ưu tiên; một số nguồn trả field "m3u8" trực tiếp */
            link_m3u8: it.m3u8 || "",
            link_embed: it.embed || ""
        })).filter(ep => ep.link_m3u8 || ep.link_embed)
    })).filter(s => s.server_data.length);
}

/* ---------- GỘP SERVER THEO NGÔN NGỮ (giảm rườm rà tabs) ----------
   Cả 2 nguồn (KKPhim + Nguonc) gom về dạng:
   { server_name: "Vietsub", server_data: [{ name, slug, link_m3u8, embeds: [url...] }] }
   — mỗi tập có thể có nhiều luồng (m3u8 + embed của từng nguồn);
   frontend sẽ hiển thị "Server 1/2/3..." để đổi luồng, ưu tiên m3u8. */
function normalizeLang(serverName) {
    const n = String(serverName || "").toLowerCase();
    if (/lồng ?tiếng|long ?tieng/.test(n)) return "Lồng Tiếng";
    if (/thuyết ?minh|thuyet ?minh/.test(n)) return "Thuyết Minh";
    if (/vietsub|vietsu/.test(n)) return "Vietsub";
    return (serverName || "Khác").trim();
}
/* Chuẩn hóa TÊN TẬP về dạng thống nhất "Tập 01", "Tập 100"... (đệm 0 cho 2 chữ số).
   Chỉ đổi khi tên là SỐ thuần ("1", "01") hoặc đã ở dạng "Tập N"
   -> giữ nguyên tên đặc biệt: "Full", "Hoàn Tất (13/13)", "Tập đặc biệt"... */
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
            /* KKPhim trả link_m3u8 + link_embed; Nguonc trả link_embed (+link_m3u8 nếu có) */
            const m3u8 = ep.link_m3u8 || "";
            const embeds = [];
            if (ep.link_embed) embeds.push(ep.link_embed);
            if (ep.embeds) embeds.push(...ep.embeds);
            if (!m3u8 && !embeds.length) continue;
            /* gộp theo SỐ TẬP (không phụ thuộc tên — "Tập 01" của KKPhim = "1" của Nguonc);
               tên hiển thị chuẩn hóa qua formatEpName() -> luôn dạng "Tập 01" */
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
    /* sắp xếp tập theo số tăng dần; bỏ key nội bộ trước khi trả về */
    const out = [];
    for (const [lang, eps] of map) {
        eps.sort((a, b) => (parseInt(a._key, 10) || 0) - (parseInt(b._key, 10) || 0));
        for (const ep of eps) delete ep._key;
        out.push({ server_name: lang, server_data: eps });
    }
    /* thứ tự ưu tiên: Vietsub > Thuyết Minh > Lồng Tiếng > còn lại */
    const prio = { "Vietsub": 0, "Thuyết Minh": 1, "Lồng Tiếng": 2 };
    out.sort((a, b) => (prio[a.server_name] ?? 9) - (prio[b.server_name] ?? 9));
    return out;
}

/* Ghép server Nguonc vào kết quả chi tiết phim nguồn 1 (KKPhim).
   Đối chiếu phim bằng slug -> nếu không thấy, thử TMDB id + loại phim. */
async function mergeNguonc(req, episodes, item) {
    try {
        let m2 = null;
        try { m2 = await fetchJson(`${API2}/film/${encodeURIComponent(req.params.slug)}`); }
        catch { /* slug không trùng — thử tiếp theo TMDB */ }
        if (!m2?.movie && item?.tmdb?.id) {
            const type = item.tmdb.type === "tv" || item.type === "series" ? "tv" : "movie";
            try {
                const found = await fetchJson(
                    `${API2}/films/search?keyword=${encodeURIComponent(String(item.tmdb.id))}&page=1`
                );
                const hit = (found.items || []).find(x =>
                    (x.tmdb?.id === item.tmdb.id) &&
                    (type === "tv" ? true : x.tmdb?.type !== "tv"));
                if (hit) m2 = await fetchJson(`${API2}/film/${encodeURIComponent(hit.slug)}`);
            } catch { /* bỏ qua */ }
        }
        const extra = normalizeNguonc(m2?.movie);
        if (extra.length) episodes.push(...extra);
        /* Ảnh: Nguonc (nguồn 2) có ảnh webp đẹp hơn -> ưu tiên dùng ảnh Nguonc
           để trang chi tiết giống hệt ảnh đã thấy trên trang chủ (cũng là Nguonc).
           Chỉ dùng ảnh KKPhim khi Nguonc không có (tránh ảnh trống). */
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

/* Graceful shutdown — Railway gửi SIGTERM khi redeploy */
process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
});
