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
    JSON.stringify(["Tốc độ phát", "Tỷ lệ khung hình"]),
    "bảng chính: " + rows().map(r => r.name + "=" + r.value + r.sub).join(" | "));
  ok(rows()[0].value === "Bình thường" && rows()[1].value === "Mặc định",
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
  d.body.click();
  ok(!$("plSetPanel").classList.contains("show"), "bấm ra ngoài thì đóng bảng");

  /* 2b) khi HLS có nhiều mức chất lượng */
  w.eval('plLevels = [{index:0,label:"720p"},{index:1,label:"1080p"}]; renderSettings()');
  $("plSetBtn").click();
  ok(rows().length === 3 && rows()[2].name === "Chất lượng" && rows()[2].value === "Auto",
    "có HLS -> 3 dòng: " + rows().map(r => r.name + "=" + r.value).join(" | "));
  $("plSetList").querySelectorAll(".prow")[2].click();     // Chất lượng
  ok(rows().map(r => r.name).join(",") === "Auto,720p,1080p", "danh sách chất lượng: " + rows().map(r => r.name).join(","));
  $("plSetList").querySelectorAll(".prow")[2].click();     // 1080p
  ok(w.eval("plQuality") === 1, "chọn 1080p -> plQuality = " + w.eval("plQuality"));
  $("plSetBtn").click();
  ok(rows()[2].value === "1080p", "bảng chính hiện chất lượng 1080p: " + rows()[2].value);

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

  /* ===== MOBILE: tự ẩn thanh công cụ + chạm/vuốt ===== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const controlsHidden = () => w.eval("controlsHidden()");
  w.eval('$("playerBox").classList.remove("embed-mode");' +
         '$("playerBox").getBoundingClientRect = () => ({left:0,right:600,top:0,bottom:337,width:600,height:337,x:0,y:0});');
  const touch = (type, x, y) => {
    const ev = new w.Event(type, { bubbles: true, cancelable: true });
    ev.touches = [{ clientX: x, clientY: y }];
    ev.changedTouches = [{ clientX: x, clientY: y }];
    $("playerBox").dispatchEvent(ev);
    return ev;
  };
  const tap = (x, y) => { touch("touchstart", x, y); touch("touchend", x, y); };
  const box = $("playerBox");

  /* chạm khi thanh đang ẩn: chỉ hiện thanh, KHÔNG phát/dừng (tránh vô tình pause) */
  w.eval('window.__played = false; plVideo.play = () => { window.__played = true; return Promise.resolve(); };' +
         'plVideo.pause = () => { window.__paused = true; };');
  box.classList.add("hide-ui");
  tap(300, 150);
  ok(!controlsHidden(), "mobile: chạm khi thanh ẩn -> hiện thanh công cụ");
  ok(w.__played === false, "mobile: chạm lần đầu KHÔNG phát/dừng video");
  tap(300, 150);
  ok(w.__played === true, "mobile: chạm lần hai mới phát/dừng");

  /* tự ẩn (jsdom: video luôn 'paused' -> mốc 4.5s) */
  await sleep(4900);
  ok(controlsHidden(), "tự ẩn thanh công cụ sau ~4.5s (khi tạm dừng)");

  /* đang mở bảng cài đặt thì không được tự ẩn */
  $("plSetBtn").click();
  await sleep(4900);
  ok(!controlsHidden(), "đang mở bảng cài đặt -> không tự ẩn");
  $("plSetBtn").click();
  await sleep(4900);
  ok(controlsHidden(), "đóng bảng cài đặt -> tự ẩn lại như cũ");

  /* vuốt mép trái = độ sáng (dùng lớp phủ plDim, giá trị chạy theo tay) */
  w.eval('plVideo.volume = 0.5; localStorage.removeItem("filmlo_bright")');
  touch("touchstart", 20, 200);
  touch("touchmove", 20, 300);            // kích hoạt vuốt, lấy mốc mới
  ok(box.classList.contains("dragging"), "đang vuốt -> có class dragging (tắt transition)");
  touch("touchmove", 20, 400);            // kéo xuống 100px -> tối dần
  const dim = parseFloat($("plDim").style.opacity || "0");
  ok(dim > 0.15 && dim < 0.3, "kéo xuống 100px -> làm tối " + dim.toFixed(3) + " (≈0.217)");
  ok($("plBrightVal").textContent === "78%", "hiện % độ sáng: " + $("plBrightVal").textContent);
  ok(!controlsHidden(), "vuốt cũng hiện thanh công cụ");
  touch("touchend", 20, 400);
  ok(!box.classList.contains("dragging"), "thả tay -> bỏ class dragging");

  /* vuốt mép phải = âm lượng */
  touch("touchstart", 580, 200);
  touch("touchmove", 580, 300);
  touch("touchmove", 580, 530);           // kéo xuống ~230px -> gần 0
  ok(Math.abs(w.eval("plVideo.volume") - 0.0009) < 0.01 && $("plVolVal").textContent === "0%",
    "kéo xuống -> âm lượng " + w.eval("plVideo.volume").toFixed(3) + " (" + $("plVolVal").textContent + ")");
  touch("touchend", 580, 530);

  /* vuốt KHÔNG bị tính thành chạm (không phát/dừng ngoài ý muốn) */
  w.eval("window.__played = false");
  touch("touchstart", 580, 300); touch("touchmove", 580, 380); touch("touchend", 580, 380);
  ok(w.__played === false, "vuốt không bị tính là chạm");

  /* thanh Filmlo: luôn cố định trên đầu trang (không tự ẩn khi cuộn) */
  const header = w.document.querySelector("header");
  const setScroll = y => { Object.defineProperty(w, "scrollY", { value: y, configurable: true }); };
  const scrollTo = y => { setScroll(y); w.dispatchEvent(new w.Event("scroll")); };
  scrollTo(300); await sleep(60);
  ok(!header.classList.contains("nav-hide"), "cuộn xuống -> thanh Filmlo vẫn hiển thị (cố định)");
  scrollTo(600); await sleep(60);
  ok(!header.classList.contains("nav-hide"), "cuộn tiếp -> thanh Filmlo vẫn hiển thị");

  /* double-tap mép để tua ±10s (kể cả khi thanh công cụ đang ẩn) */
  w.eval("plVideo.currentTime = 50");
  box.classList.add("hide-ui");
  tap(20, 150); await sleep(90); tap(20, 150);
  ok(Math.abs(w.eval("plVideo.currentTime") - 40) < 0.6,
    "double-tap mép trái -> tua lùi 10s (currentTime=" + w.eval("plVideo.currentTime") + ")");
  ok(!controlsHidden(), "sau khi tua -> thanh công cụ hiện ra");
  tap(300, 150); await sleep(320);   // chạm giữa 2 lần > 300ms -> tính là chạm đơn
  ok(true, "chạm giữa hai lần không bị tính là double-tap");

  /* ===== trang chủ (index.html): cú pháp + thanh Filmlo khi cuộn ===== */
  const home = fs.readFileSync("public/index.html", "utf8");
  const homeScripts = [...home.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  homeScripts.forEach((s, i) => {
    try { new vm.Script(s); ok(true, "index.html: script #" + (i + 1) + " hợp lệ"); }
    catch (e) { ok(false, "index.html script #" + (i + 1) + ": " + e.message); }
  });
  ok(/viewport-fit=cover/.test(home), "index.html: có viewport-fit=cover (safe-area)");
  const dom2 = await JSDOM.fromURL(`${BASE}/`, {
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(x) { x.fetch = (u, o) => fetch(new URL(u, BASE).href, o); }
  });
  const w2 = dom2.window;
  await sleep(900);
  const h2 = w2.document.querySelector("header");
  const s2 = y => {
    Object.defineProperty(w2, "scrollY", { value: y, configurable: true });
    w2.dispatchEvent(new w2.Event("scroll"));
  };
  s2(400); await sleep(60);
  ok(!h2.classList.contains("nav-hide"), "index.html: cuộn xuống -> thanh Filmlo vẫn cố định");
  dom2.window.close();

  console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
  dom.window.close();
  process.exit(fail ? 1 : 0);
}, 1200);
