// Kiểm tra tạm thanh công cụ player m3u8 (script dev, xoá sau khi test)
process.env.PORT = "4040";
process.chdir("c:/Users/nguye/Desktop/Filmlo");
const fs = require("fs");
const vm = require("vm");
const { JSDOM, VirtualConsole } = require("jsdom");
require("./server.js");

const HTML = fs.readFileSync("public/movie.html", "utf8");
const BASE = "http://127.0.0.1:4040";
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) fail++; };

/* 1) cú pháp JS nhúng + mọi $("id") phải tồn tại trong HTML */
const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
try { new vm.Script(script); ok(true, "cú pháp script nhúng hợp lệ"); }
catch (e) { ok(false, "cú pháp script: " + e.message); }
const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
const missing = [...used].filter(id => !ids.has(id));
ok(!missing.length, 'mọi $("id") đều có trong HTML' + (missing.length ? " (thiếu: " + missing.join(",") + ")" : ""));

setTimeout(async () => {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => console.log("jsdomError:", e.message));
  const dom = await JSDOM.fromURL(`${BASE}/phim/thiep-von-chi-la-co-rac`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, BASE).href, o);
      /* jsdom không cài đặt play/pause của HTMLMediaElement */
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.HTMLMediaElement.prototype.pause = function () {};
    }
  });
  const w = dom.window, d = w.document;
  const $ = id => d.getElementById(id);
  await new Promise(r => setTimeout(r, 1800));

  ok($("detail").style.display === "block", "tải được thông tin phim");
  ok($("plTime").textContent === "00:00 / 00:00", "thời gian mặc định mm:ss -> " + $("plTime").textContent);
  ok(w.eval("fmtTime(2794)") === "46:34", "fmtTime(2794) = " + w.eval("fmtTime(2794)"));
  ok(w.eval("fmtTime(3723)") === "1:02:03", "fmtTime(3723) = " + w.eval("fmtTime(3723)"));
  ok($("plPip").style.display === "none", "nút PiP ẩn khi chưa có video");

  /* 2) bảng cài đặt ⚙ */
  const rows = () => [...$("plSetList").querySelectorAll(".prow")].map(b => ({
    name: b.querySelector(".pn").textContent,
    value: b.querySelector(".pv") ? b.querySelector(".pv").textContent : "",
    sub: b.querySelector(".pc").textContent
  }));
  $("plSetBtn").click();
  ok($("plSetPanel").classList.contains("show"), "bấm ⚙ mở bảng cài đặt");
  $("plSetPanel").click();
  ok($("plSetPanel").classList.contains("show"), "bấm trong bảng thì không tự đóng");
  ok(JSON.stringify(rows().map(r => r.name)) ===
    JSON.stringify(["Tốc độ phát", "Tỷ lệ khung hình", "Mạch chủ"]),
    "bảng chính: " + rows().map(r => r.name + "=" + r.value + r.sub).join(" | "));
  ok(rows()[0].value === "Bình thường" && rows()[1].value === "Mặc định" && rows()[2].value === "Mặc định",
    "giá trị mặc định đúng");

  $("plSetList").querySelectorAll(".prow")[0].click();
  ok($("plSetPanel").classList.contains("sub") && $("plSetTitle").textContent === "Tốc độ phát",
    "mở bảng con tốc độ phát");
  ok(rows().length === 6 && rows()[2].name === "Bình thường", "6 mức tốc độ: " + rows().map(r => r.name).join(","));
  $("plSetList").querySelectorAll(".prow")[3].click();     // 1.25x
  ok(!$("plSetPanel").classList.contains("show"), "chọn xong thì đóng bảng");
  ok(Math.abs(w.eval("plRate") - 1.25) < 1e-9 && w.localStorage.getItem("filmlo_rate") === "1.25",
    "áp dụng + lưu tốc độ 1.25x");

  $("plSetBtn").click();
  ok(rows()[0].value === "1.25x", "bảng chính hiện tốc độ đã chọn: " + rows()[0].value);
  $("plSetList").querySelectorAll(".prow")[1].click();     // Tỷ lệ khung hình
  ok(rows().length === 4 && rows()[0].name === "Mặc định", "4 tỷ lệ khung hình: " + rows().map(r => r.name).join(","));
  $("plSetList").querySelectorAll(".prow")[2].click();     // 4:3
  ok($("playerBox").classList.contains("pl-ratio-4x3") && !$("playerBox").classList.contains("pl-ratio-default"),
    "áp dụng tỷ lệ 4:3 -> " + $("playerBox").className);
  ok(w.localStorage.getItem("filmlo_ratio") === "4x3", "lưu tỷ lệ vào localStorage");
  $("plSetBtn").click();
  $("plSetList").querySelectorAll(".prow")[2].click();     // Mạch chủ
  ok(rows().length === 1 && rows()[0].name === "Mặc định" && rows()[0].sub === "✓",
    "mạch chủ mặc định khi chưa có HLS: " + JSON.stringify(rows()));
  $("plSetBack").click();
  ok($("plSetTitle").textContent === "" && !$("plSetPanel").classList.contains("sub"), "nút ‹ quay lại bảng chính");
  d.body.click();
  ok(!$("plSetPanel").classList.contains("show"), "bấm ra ngoài thì đóng bảng");

  /* 2b) khi HLS có nhiều mức chất lượng + nhiều mạch chủ */
  w.eval('plLevels = [{index:0,label:"720p"},{index:1,label:"1080p"}];' +
         'plAudios = [{index:0,label:"Sao Hỏa"},{index:1,label:"Vietsub"}]; renderSettings()');
  $("plSetBtn").click();
  ok(rows().length === 4 && rows()[2].name === "Chất lượng" && rows()[2].value === "Auto" &&
     rows()[3].name === "Mạch chủ" && rows()[3].value === "Sao Hỏa",
    "có HLS -> 4 dòng: " + rows().map(r => r.name + "=" + r.value).join(" | "));
  $("plSetList").querySelectorAll(".prow")[2].click();     // Chất lượng
  ok(rows().map(r => r.name).join(",") === "Auto,720p,1080p", "danh sách chất lượng: " + rows().map(r => r.name).join(","));
  $("plSetList").querySelectorAll(".prow")[2].click();     // 1080p
  ok(w.eval("plQuality") === 1, "chọn 1080p -> plQuality = " + w.eval("plQuality"));
  $("plSetBtn").click();
  ok(rows()[2].value === "1080p", "bảng chính hiện chất lượng 1080p: " + rows()[2].value);
  $("plSetList").querySelectorAll(".prow")[3].click();     // Mạch chủ
  ok(rows().map(r => r.name).join(",") === "Sao Hỏa,Vietsub", "danh sách mạch chủ: " + rows().map(r => r.name).join(","));
  $("plSetList").querySelectorAll(".prow")[1].click();     // Vietsub
  ok(w.eval("plAudio") === 1, "chọn mạch Vietsub -> plAudio = " + w.eval("plAudio"));

  /* 3) dựng player m3u8 (jsdom không có HLS -> rơi về thông báo dự phòng) */
  w.eval('playDirect("https://example.com/phim/tap-01.m3u8")');
  const video = $("playerBox").querySelector("video");
  ok(!!video, "tạo thẻ <video> trong player-box");
  ok(video && video.getAttribute("playsinline") !== null, "video có playsinline");
  ok($("playerBox").classList.contains("pl-ratio-4x3"), "giữ tỷ lệ 4:3 khi tạo video mới");
  ok($("playerErr").style.display === "block", "hiện cảnh báo khi m3u8 không phát được");
  ok($("plPip").style.display === "none", "PiP vẫn ẩn (không hỗ trợ)");

  /* thanh âm lượng dọc */
  ok(!!$("plVolTrack") && $("plVolNum").textContent === "100", "thanh âm lượng hiện 100");
  w.eval("plVideo.volume = 0.26; plVideo.dispatchEvent(new Event('volumechange'))");
  ok($("plVolNum").textContent === "26" && $("plVolPopFill").style.height === "26%" &&
     $("plVolPopKnob").style.bottom === "26%", "thanh dọc + số % cập nhật theo volume 0.26");
  $("plMute").click();
  ok(video.muted === true, "nút loa tắt tiếng");
  $("plMute").click();
  ok(video.muted === false, "nút loa bật lại tiếng");

  /* các nút còn lại bấm không lỗi */
  $("plPlay").click();
  $("plBack10").click();
  $("plFwd10").click();
  ok(true, "nút ⏪ ▶ ⏩ bấm không lỗi");
  const rowBtns = [...$("plControls").querySelectorAll(
    ".pl-row > button,.pl-row > div.pl-vol > button,.pl-row > div.pl-set > button")].map(b => b.id);
  ok(rowBtns.length === 7 && rowBtns.join(",") === "plBack10,plPlay,plFwd10,plMute,plSetBtn,plPip,plFs",
    "hàng nút: " + rowBtns.join(","));
  ok($("plFs").classList.contains("pl-fs-row"), "nút toàn màn hình có class pl-fs-row (ẩn trên mobile)");

  /* thanh tua + thời gian */
  Object.defineProperty(video, "duration", { value: 2794, configurable: true });
  video.currentTime = 10;
  video.dispatchEvent(new w.Event("loadedmetadata"));
  video.dispatchEvent(new w.Event("timeupdate"));
  ok($("plTime").textContent === "00:10 / 46:34", "thanh thời gian: " + $("plTime").textContent);
  ok($("plProgress").style.width.startsWith("0.357") && $("plKnob").style.left.startsWith("0.357"),
    "tiến trình: " + $("plProgress").style.width);

  console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
  dom.window.close();
  process.exit(fail ? 1 : 0);
}, 1200);
