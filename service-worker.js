/**
 * service-worker.js — Video Bằng Chứng Đóng Gói (PWA độc lập)
 *
 * Chiến lược:
 * - Cache-first cho toàn bộ app shell (index.html, manifest, icon, thư viện ZXing)
 *   → app mở được kể cả không có mạng
 * - Network-first cho mọi request upload lên Cloudinary
 *   → luôn dùng kết nối thật khi upload, không bao giờ trả cache cho request đó
 */

const CACHE_NAME = "video-proof-cache-v4";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "https://unpkg.com/@zxing/library@0.20.0"
];

// ─── Cài đặt: tải trước toàn bộ app shell vào cache ───
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Dùng { cache: "reload" } để chắc chắn lấy bản mới nhất từ mạng khi cài lần đầu
      return Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => cache.put(url, res))
            .catch(() => null) // Nếu 1 tài nguyên lỗi (VD offline lúc cài) vẫn không chặn cài đặt
        )
      );
    })
  );
  self.skipWaiting();
});

// ─── Kích hoạt: dọn cache phiên bản cũ ───
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: định tuyến theo loại request ───
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Không bao giờ can thiệp vào request upload lên Apps Script — luôn để mạng xử lý trực tiếp
  if (url.includes("script.google.com")) {
    return; // Không gọi event.respondWith() -> trình duyệt tự fetch bình thường
  }

  // Cache-first cho mọi thứ còn lại (app shell + thư viện ZXing)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((res) => {
          // Chỉ cache các response hợp lệ (status 200, basic hoặc cors)
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() => {
          // Offline và không có trong cache — với navigation request, trả về index.html làm fallback
          if (event.request.mode === "navigate") {
            return caches.match("/index.html");
          }
        });
    })
  );
});
