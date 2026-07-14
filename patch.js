const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// Replace upload logic
const oldLogic = `// Bước 1: Xin Apps Script mở phiên Resumable Upload
async function getUploadUrl(fileName, mimeType, trackingCode) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      action: "getUploadUrl",
      key: CONFIG.SECRET_KEY,
      data: { fileName, mimeType, trackingCode }
    })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch(e) { throw new Error("Apps Script trả về dữ liệu không hợp lệ."); }
  if (!json.ok || !json.uploadUrl) throw new Error(json.error || "Không lấy được upload URL.");
  return json.uploadUrl;
}

// Bước 2: PUT blob thẳng lên Drive, progress thật 0–100%
function uploadBlobToUrl(uploadUrl, blob, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve({}); }
      } else {
        reject(new Error(\`Upload thất bại. Drive trả về HTTP \${xhr.status}.\`));
      }
    };
    xhr.onerror = () => reject(new Error("Lỗi mạng khi upload lên Drive."));
    xhr.ontimeout = () => reject(new Error("Timeout khi upload."));
    xhr.timeout = 600000; // 10 phút
    xhr.send(blob);
  });
}

// Bước 3: Ghi log vào Sheet (thất bại cũng không sao — video đã lên Drive rồi)
async function logVideoToSheet(trackingCode, fileName, driveFileId, uploadDateIso) {
  const driveUrl = \`https://drive.google.com/file/d/\${driveFileId}/view\`;
  try {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "logVideo",
        key: CONFIG.SECRET_KEY,
        data: { trackingCode, fileName, driveUrl, uploadDate: uploadDateIso }
      })
    });
    const json = await res.json().catch(() => ({}));
    return { ...json, driveUrl };
  } catch(e) {
    console.warn("[logVideo] Lỗi ghi log:", e.message);
    return { ok: false, driveUrl };
  }
}

// ── Hàm upload chính ─────────────────────────────────────────────────────────
let isUploading = false;

async function uploadVideoToDrive(blob, trackingCodeValue) {
  if (isUploading) return;
  isUploading = true;

  appState = "uploading";
  localSaveDone = false;
  document.getElementById("actionOverlay").classList.add("show");
  document.getElementById("scanReticle").style.display = "none";
  document.getElementById("scanHint").classList.add("hidden");
  showEl("btnStopRecord", false); showEl("rowRetry", false); showEl("videoResultLink", false);
  showEl("btnNewRecording", false); showEl("btnSaveLocalManual", true);

  const ug = document.getElementById("uploadGroup"); ug.style.display = "flex";
  showEl("statusLine2", false); updateProgress(0);
  document.getElementById("statusLine").innerHTML = \`📦 Đang kết nối Drive cho mã <strong>\${trackingCodeValue}</strong>...\`;

  requestWakeLock();

  const ext = (blob.type || "video/webm").includes("mp4") ? "mp4" : "webm";
  const mimeType = blob.type || "video/webm";
  const fileName = \`\${sanitizeForFileName(trackingCodeValue)}_\${fileTimestamp(new Date())}.\${ext}\`;
  const uploadDateIso = new Date().toISOString();

  try {
    // 1. Lấy URL phiên upload
    document.getElementById("statusLine").innerHTML = \`🔗 Đang mở phiên upload...\`;
    const uploadUrl = await getUploadUrl(fileName, mimeType, trackingCodeValue);

    // 2. Đẩy video lên Drive
    document.getElementById("statusLine").innerHTML = \`⏫ Đang upload video...\`;
    const driveResponse = await uploadBlobToUrl(uploadUrl, blob, mimeType, (pct) => {
      updateProgress(pct);
      document.getElementById("statusLine").innerHTML = \`⏫ Đang upload: <strong>\${pct}%</strong>\`;
    });

    // 3. Ghi log
    updateProgress(100);
    document.getElementById("statusLine").innerHTML = \`✅ Hoàn tất! Đang ghi nhật ký...\`;
    const driveFileId = driveResponse.id;
    const logResult = await logVideoToSheet(trackingCodeValue, fileName, driveFileId, uploadDateIso);
    const driveUrl = logResult.driveUrl || (driveFileId ? \`https://drive.google.com/file/d/\${driveFileId}/view\` : null);

    releaseWakeLock();
    enterDoneState({ driveUrl });

  } catch (err) {
    releaseWakeLock();
    console.warn("[Upload] Thất bại:", err.message);
    document.getElementById("statusLine").innerHTML = \`⚠️ Upload thất bại, đang lưu vào bộ nhớ máy...\`;
    const saved = saveVideoLocally(blob, trackingCodeValue);
    enterErrorState(
      saved ? "Upload thất bại, đã lưu video vào bộ nhớ máy." : "Upload thất bại và không tự lưu được video. Bấm 'Lưu video xuống máy' để thử lại.",
      { autoSaved: saved }
    );
  } finally {
    isUploading = false;
  }
}`;

const newLogic = `const CHUNK_SIZE = 3 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 30000;
const CHUNK_MAX_RETRIES = 3;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function withTimeout(promise, ms) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms))]); }

async function getUploadUrl(fileName, mimeType, trackingCode, fileSize) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ action: "getUploadUrl", key: CONFIG.SECRET_KEY, data: { fileName, mimeType, trackingCode, fileSize } }) });
  const text = await res.text(); let json;
  try { json = JSON.parse(text); } catch(e) { throw new Error("Apps Script trả về dữ liệu không hợp lệ."); }
  if (!json.ok || !json.uploadUrl) throw new Error(json.error || "Không lấy được upload URL.");
  return json.uploadUrl;
}

async function sendChunkToProxy(chunkBlob, meta) {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = () => reject(new Error("Không đọc được dữ liệu chunk.")); reader.readAsDataURL(chunkBlob);
  });
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ action: "uploadVideoChunk", key: CONFIG.SECRET_KEY, data: { uploadUrl: meta.uploadUrl, chunkIndex: meta.chunkIndex, totalChunks: meta.totalChunks, base64: base64, startByte: meta.startByte, chunkSize: chunkBlob.size, totalSize: meta.totalSize } }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

async function uploadChunkWithRetry(chunkBlob, meta) {
  for (let attempt = 1; attempt <= CHUNK_MAX_RETRIES; attempt++) {
    try { return await withTimeout(sendChunkToProxy(chunkBlob, meta), CHUNK_TIMEOUT_MS); }
    catch (err) { console.warn(\`[Chunk \${meta.chunkIndex + 1}/\${meta.totalChunks}] Lỗi lần \${attempt}:\`, err.message); if (attempt < CHUNK_MAX_RETRIES) await sleep(800 * attempt); }
  }
  throw new Error(\`Chunk \${meta.chunkIndex + 1}/\${meta.totalChunks} thất bại sau \${CHUNK_MAX_RETRIES} lần thử.\`);
}

async function logVideoToSheet(trackingCode, fileName, driveFileId, uploadDateIso) {
  const driveUrl = \`https://drive.google.com/file/d/\${driveFileId}/view\`;
  try {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ action: "logVideo", key: CONFIG.SECRET_KEY, data: { trackingCode, fileName, driveUrl, uploadDate: uploadDateIso } }) });
    const json = await res.json().catch(() => ({})); return { ...json, driveUrl };
  } catch(e) { return { ok: false, driveUrl }; }
}

let isUploading = false;
async function uploadVideoToDrive(blob, trackingCodeValue) {
  if (isUploading) return;
  isUploading = true; appState = "uploading"; localSaveDone = false;
  document.getElementById("actionOverlay").classList.add("show");
  document.getElementById("scanReticle").style.display = "none";
  document.getElementById("scanHint").classList.add("hidden");
  showEl("btnStopRecord", false); showEl("rowRetry", false); showEl("videoResultLink", false);
  showEl("btnNewRecording", false); showEl("btnSaveLocalManual", true);
  const ug = document.getElementById("uploadGroup"); ug.style.display = "flex";
  showEl("statusLine2", false); updateProgress(0);
  document.getElementById("statusLine").innerHTML = \`📦 Đang kết nối Drive cho mã <strong>\${trackingCodeValue}</strong>...\`;
  requestWakeLock();
  const ext = (blob.type || "video/webm").includes("mp4") ? "mp4" : "webm";
  const mimeType = blob.type || "video/webm";
  const fileName = \`\${sanitizeForFileName(trackingCodeValue)}_\${fileTimestamp(new Date())}.\${ext}\`;
  const uploadDateIso = new Date().toISOString();
  const totalSize = blob.size;
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
  try {
    document.getElementById("statusLine").innerHTML = \`🔗 Đang mở phiên upload...\`;
    const uploadUrl = await getUploadUrl(fileName, mimeType, trackingCodeValue, totalSize);
    let driveFileId = null;
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE; const end = Math.min(start + CHUNK_SIZE, totalSize);
      const res = await uploadChunkWithRetry(blob.slice(start, end), { uploadUrl, chunkIndex: i, totalChunks, startByte: start, totalSize });
      const pct = Math.round(((i + 1) / totalChunks) * 100);
      updateProgress(pct); document.getElementById("statusLine").innerHTML = \`⏫ Đang upload: <strong>\${pct}%</strong> (\${i + 1}/\${totalChunks} phần)\`;
      if (i === totalChunks - 1) driveFileId = res.fileId;
    }
    document.getElementById("statusLine").innerHTML = \`✅ Hoàn tất! Đang ghi nhật ký...\`;
    const logResult = await logVideoToSheet(trackingCodeValue, fileName, driveFileId, uploadDateIso);
    const driveUrl = logResult.driveUrl || (driveFileId ? \`https://drive.google.com/file/d/\${driveFileId}/view\` : null);
    releaseWakeLock(); enterDoneState({ driveUrl });
  } catch (err) {
    releaseWakeLock(); console.warn("[Upload] Thất bại:", err.message);
    document.getElementById("statusLine").innerHTML = \`⚠️ Upload thất bại, đang lưu vào bộ nhớ máy...\`;
    const saved = saveVideoLocally(blob, trackingCodeValue);
    enterErrorState(saved ? "Upload thất bại, đã lưu video vào bộ nhớ máy." : "Upload thất bại và không tự lưu được video. Bấm 'Lưu video xuống máy' để thử lại.", { autoSaved: saved });
  } finally { isUploading = false; }
}`;

let newHtml = html.replace(oldLogic.replace(/\r\n/g, '\n'), newLogic.replace(/\r\n/g, '\n'));
if(newHtml === html) {
   // Try with CRLF
   newHtml = html.replace(oldLogic, newLogic);
}

const oldComment = "/* =========================================================================\n * DRIVE RESUMABLE UPLOAD — Apps Script tạo session URL, Frontend tự PUT\n * =========================================================================\n * Luồng:\n *  1. Gọi Apps Script action=\"getUploadUrl\"  → nhận uploadUrl (Drive session)\n *  2. PUT video blob thẳng lên uploadUrl     → Drive nhận file, không qua GAS\n *  3. Gọi Apps Script action=\"logVideo\"      → GAS ghi trackingCode/link vào Sheet\n * ========================================================================= */";
const newComment = "/* =========================================================================\n * DRIVE RESUMABLE UPLOAD — Chunked Proxy Upload\n * ========================================================================= */";

newHtml = newHtml.replace(oldComment, newComment);
newHtml = newHtml.replace(oldComment.replace(/\n/g, '\r\n'), newComment);

fs.writeFileSync('index.html', newHtml, 'utf8');
console.log('done');
