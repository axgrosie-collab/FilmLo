process.env.PORT = "4030";
process.chdir("c:/Users/nguye/Desktop/Filmlo");
const http = require("http");
require("./server.js");

const base = "http://127.0.0.1:4030";

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers: { "User-Agent": "Mozilla/5.0" } }, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => resolve({ status: r.statusCode, body: d }));
    }).on("error", reject);
  });
}

setTimeout(async () => {
  try {
    const slug = "thiep-von-chi-la-co-rac";
    const r1 = await get(`/api/movie/${slug}`);
    console.log("/api/movie status:", r1.status, "bytes:", r1.body.length);
    try {
      const j = JSON.parse(r1.body);
      console.log("keys:", Object.keys(j).join(","));
      const m = j.movie || j.data?.movie;
      const eps = j.episodes || j.data?.episodes;
      console.log("movie name:", m?.name);
      console.log("episodes:", JSON.stringify(eps?.slice(0, 2)));
      if (!m || !eps || !eps.length) console.log("!! MISSING movie or episodes");
    } catch (e) { console.log("!! not JSON:", r1.body.slice(0, 400)); }

    const r2 = await get(`/phim/${slug}`);
    console.log("/phim status:", r2.status, "bytes:", r2.body.length);

    const r3 = await get("/api/movies?page=1");
    console.log("/api/movies status:", r3.status, "bytes:", r3.body.length);
  } catch (e) {
    console.log("ERR", e.message);
  }
  process.exit(0);
}, 2500);
