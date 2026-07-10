/**
 * service-worker.js — Video Bằng Chứng Đóng Gói (PWA)
 *
 * - Cache-first cho app shell → app mở được kể cả không có mạng
 * - Bypass hoàn toàn mọi request tới script.google.com → luôn fetch thật
 */

const CACHE_NAME = "video-proof-cache-v11";

// Chỉ cache các tài nguyên local, bỏ CDN ngoài (CDN tự cache bởi browser)
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// ─── Cài đặt ───────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => {
              if (res && res.status === 200) return cache.put(url, res);
            })
            .catch(() => null)
        )
      )
    ).then(() => self.skipWaiting()) // skipWaiting sau khi cache xong
  );
});

// ─── Kích hoạt: dọn cache cũ ───────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Bypass: Apps Script upload/query, CDN scripts — luôn fetch thật
  if (
    url.includes("script.google.com") ||
    url.includes("unpkg.com") ||
    url.includes("cdn.jsdelivr.net") ||
    url.includes("fonts.googleapis.com") ||
    url.includes("fonts.gstatic.com")
  ) {
    return; // Không gọi event.respondWith → browser tự fetch
  }

  // Cache-first cho app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type !== "opaque") {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => {
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
