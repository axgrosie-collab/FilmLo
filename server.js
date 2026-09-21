/**
 * Filmlo — proxy cho phimapi.com (KKPhim API)
 * Deploy Railway: npm start (PORT do Railway cấp)
 */

const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const API = "https://phimapi.com";

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

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

/* Phim mới cập nhật */
listRoute("/api/movies", q =>
    `${API}/danh-sach/phim-moi-cap-nhat?page=${q.page}&limit=48`
);

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

/* Tìm kiếm */
listRoute("/api/search", q =>
    `${API}/v1/api/tim-kiem?keyword=${encodeURIComponent((q.keyword || "").trim())}&page=${q.page}&limit=48`
);

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
        // Fallback: bản gốc phimapi.com gần đây không trả episodes,
        // lấy từ API v1 của kkphim2 (vẫn đầy đủ server_data + link_m3u8).
        let fallback_error = null;
        if (!episodes.length) {
            try {
                const v1 = await fetchJson(
                    `https://kkphim2.com/v1/api/phim/${encodeURIComponent(req.params.slug)}`
                );
                episodes = v1?.episodes || v1?.data?.item?.episodes || [];
            } catch (e) {
                fallback_error = "Không tải được danh sách tập từ nguồn dự phòng: " + e.message;
                console.error("detail-fallback", e.message);
            }
        }
        res.set("Cache-Control", "public, max-age=300");
        res.json({
            success: true,
            movie: item,
            episodes,
            episodes_empty: !episodes.length,
            fallback_error,
            seo: data?.seoOnPage || data?.data?.seoOnPage || null
        });
    } catch (error) {
        console.error("detail", error.message);
        res.status(502).json({ success: false, message: "Không tải được phim." });
    }
});

/* Pretty URL: /phim/:slug -> movie.html */
app.get("/phim/:slug", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "movie.html"));
});

app.listen(PORT, () => {
    console.log(`Filmlo running on http://localhost:${PORT}`);
});
