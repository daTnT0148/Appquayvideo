/**
 * Code.gs — Backend độc lập cho App "Video Bằng Chứng Đóng Gói"
 * Hoàn toàn tách biệt, không liên quan đến bất kỳ app nào khác.
 *
 * DEPLOY: Extensions > Apps Script > dán file này > Deploy > New deployment
 *   - Type: Web app
 *   - Execute as: Me
 *   - Who has access: Anyone
 */

// ─── CẤU HÌNH ──────────────────────────────────────────────────────────────
const SHEET_ID    = "1uM5PemCsuBM2XNbRr9ME4aSC3nqwP5Fsutogsw6KcKI"; // ← Dán ID của 1 Google Sheet MỚI, TẠO RIÊNG cho app này (để trống = tự tạo Sheet mới trong Drive)
const FOLDER_ID   = "1DHIBw5JG34-PaAb12AI_khZeZ50zqjsN"; // ← Dán ID của Folder Google Drive
const SECRET_KEY  = "Kntvntd482001!"; // ← Đổi thành chuỗi bí mật riêng của bạn

const VIDEO_FOLDER_NAME   = "VideoProof_PackingEvidence";
const VIDEO_LOG_SHEET     = "VideoLog";
const VIDEO_RETENTION_DAYS = 20;

// ─── Lấy (hoặc tạo mới) Spreadsheet dùng làm log ───
function getSpreadsheet() {
  if (SHEET_ID && SHEET_ID.trim() !== "") {
    return SpreadsheetApp.openById(SHEET_ID);
  }
  // Không có SHEET_ID -> tự tạo 1 Sheet mới trong Drive gốc, tên cố định để lần sau tìm lại được
  const existing = DriveApp.getFilesByName("VideoProof_Log");
  if (existing.hasNext()) {
    return SpreadsheetApp.open(existing.next());
  }
  const ss = SpreadsheetApp.create("VideoProof_Log");
  return ss;
}

// ─── Router ─────────────────────────────────────────────────────────────────
function doGet(e) {
  const action = e && e.parameter && e.parameter.action ? e.parameter.action : "ping";
  const key    = e && e.parameter && e.parameter.key ? e.parameter.key : "";

  if (key !== SECRET_KEY) {
    return respond({ error: "Unauthorized" });
  }

  let result;
  if (action === "ping") result = { ok: true, message: "Video Proof backend hoạt động bình thường." };
  else result = { error: "Unknown action: " + action };

  return respond(result);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ error: "Invalid JSON: " + err.message });
  }

  const action = body.action;
  const key    = body.key || "";

  if (key !== SECRET_KEY) {
    return respond({ error: "Unauthorized" });
  }

  let result;
  try {
    switch (action) {
      case "uploadVideo":   result = uploadVideo(body.data);  break;
      case "cleanupVideos": result = cleanupOldVideos();      break;
      case "searchVideo":   result = searchVideo(body.data);  break;
      case "deleteVideo":   result = deleteVideo(body.data);  break;
      case "getRecentVideos": result = getRecentVideos(body.data); break;
      default: result = { error: "Unknown action: " + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return respond(result);
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Sheet log ──────────────────────────────────────────────────────────────
function ensureVideoLogSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(VIDEO_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(VIDEO_LOG_SHEET);
    sheet.appendRow(["fileName", "trackingCode", "uploadDate", "deleteDate", "fileId", "driveUrl"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
  }
  return sheet;
}

// ─── Drive folder ───────────────────────────────────────────────────────────
function getOrCreateVideoFolder() {
  if (FOLDER_ID && FOLDER_ID.trim() !== "") {
    try {
      return DriveApp.getFolderById(FOLDER_ID);
    } catch (e) {
      console.error("Không tìm thấy Folder với ID đã cấp, sẽ tạo folder mới.", e);
    }
  }

  const folders = DriveApp.getFoldersByName(VIDEO_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(VIDEO_FOLDER_NAME);
}

/**
 * Action "uploadVideo" — nhận base64 video, lưu vào Drive, ghi log vào Sheet
 * data: { base64, mimeType, fileName, trackingCode, uploadDate (ISO string) }
 */
function uploadVideo(data) {
  if (!data || !data.base64 || !data.fileName) {
    return { error: "Thiếu dữ liệu video (base64, fileName)" };
  }

  try {
    const decoded  = Utilities.base64Decode(data.base64);
    const mimeType = data.mimeType || "video/webm";
    const blob     = Utilities.newBlob(decoded, mimeType, data.fileName);

    const folder = getOrCreateVideoFolder();
    const file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const fileId   = file.getId();
    const driveUrl = "https://drive.google.com/file/d/" + fileId + "/view";

    const uploadDate = data.uploadDate ? new Date(data.uploadDate) : new Date();
    const deleteDate = new Date(uploadDate.getTime() + VIDEO_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const logSheet = ensureVideoLogSheet();
    logSheet.appendRow([data.fileName, data.trackingCode || "", uploadDate, deleteDate, fileId, driveUrl]);

    return { ok: true, fileId: fileId, driveUrl: driveUrl, fileName: data.fileName };
  } catch (err) {
    return { error: "Upload video thất bại: " + err.message };
  }
}

/**
 * Action "searchVideo" — tìm kiếm video theo mã vận đơn
 * data: { trackingCode }
 */
function searchVideo(data) {
  if (!data || !data.trackingCode) {
    return { error: "Thiếu mã vận đơn (trackingCode)" };
  }

  try {
    const sheet = ensureVideoLogSheet();
    const rows = sheet.getDataRange().getValues();
    const searchCode = data.trackingCode.toString().trim().toLowerCase();
    
    // Duyệt ngược để lấy video mới nhất (vì được append xuống dưới)
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const codeInSheet = row[1].toString().trim().toLowerCase(); // trackingCode ở cột B (index 1)
      
      if (codeInSheet === searchCode) {
        return {
          ok: true,
          fileName: row[0],
          trackingCode: row[1],
          uploadDate: row[2],
          fileId: row[4],
          driveUrl: row[5]
        };
      }
    }
    
    return { ok: false, message: "Không tìm thấy video cho mã vận đơn này." };
  } catch (err) {
    return { error: "Lỗi tìm kiếm: " + err.message };
  }
}

/**
 * Xoá các video đã quá hạn lưu trữ (deleteDate < hôm nay).
 * Gọi qua action "cleanupVideos" HOẶC qua trigger hàng ngày.
 */
function cleanupOldVideos() {
  const sheet = ensureVideoLogSheet();
  const data  = sheet.getDataRange().getValues();
  const today = new Date();
  let deletedCount = 0;

  for (let i = data.length - 1; i >= 1; i--) {
    const row        = data[i];
    const deleteDate = row[3];
    const fileId     = row[4];

    if (deleteDate instanceof Date && deleteDate < today) {
      try {
        DriveApp.getFileById(fileId).setTrashed(true);
      } catch (e) {
        // File có thể đã bị xoá tay trước đó — vẫn xoá dòng log cho gọn
      }
      sheet.deleteRow(i + 1);
      deletedCount++;
    }
  }

  return { ok: true, deletedCount: deletedCount };
}

// ─── Chạy hàm này 1 LẦN DUY NHẤT (thủ công trong Apps Script editor) để cài lịch tự động ───
function setupDailyVideoCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "cleanupOldVideos") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("cleanupOldVideos").timeBased().atHour(3).everyDays(1).create();
}

/**
 * Action "deleteVideo" — xoá video theo mã vận đơn
 * data: { trackingCode }
 */
function deleteVideo(data) {
  if (!data || !data.trackingCode) {
    return { error: "Thiếu mã vận đơn (trackingCode)" };
  }

  try {
    const sheet = ensureVideoLogSheet();
    const rows = sheet.getDataRange().getValues();
    const targetCode = data.trackingCode.toString().trim().toLowerCase();
    
    // Duyệt ngược để xoá đúng video mới nhất nếu có trùng mã
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const codeInSheet = row[1].toString().trim().toLowerCase(); // trackingCode ở cột B (index 1)
      
      if (codeInSheet === targetCode) {
        const fileId = row[4]; // fileId ở cột E (index 4)
        if (fileId) {
          try {
            DriveApp.getFileById(fileId).setTrashed(true);
          } catch (e) {
            console.warn("Lỗi xoá file Drive (có thể đã xoá): " + e.message);
          }
        }
        sheet.deleteRow(i + 1); // Row index trong Sheets bắt đầu từ 1
        return { ok: true, message: "Đã xoá video thành công." };
      }
    }
    
    return { error: "Không tìm thấy mã vận đơn để xoá." };
  } catch (err) {
    return { error: "Lỗi xoá video: " + err.message };
  }
}

/**
 * Action "getRecentVideos" — trả về N video mới nhất
 * data: { limit } (mặc định 5)
 */
function getRecentVideos(data) {
  try {
    const limit = (data && data.limit) ? parseInt(data.limit) : 5;
    const sheet = ensureVideoLogSheet();
    const rows = sheet.getDataRange().getValues();
    
    const videos = [];
    // Duyệt ngược (mới nhất trước)
    for (let i = rows.length - 1; i >= 1 && videos.length < limit; i--) {
      const row = rows[i];
      if (!row[1]) continue; // Bỏ qua dòng rỗng
      videos.push({
        fileName:     row[0],
        trackingCode: row[1],
        uploadDate:   row[2] ? new Date(row[2]).toISOString() : null,
        fileId:       row[4],
        driveUrl:     row[5]
      });
    }
    
    return { ok: true, videos: videos };
  } catch (err) {
    return { error: "Lỗi lấy danh sách video: " + err.message };
  }
}

