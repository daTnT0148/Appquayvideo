// ============================================================
// CẤU HÌNH — Sửa 2 giá trị này cho đúng với tài khoản của bạn
// ============================================================
const SECRET_KEY      = "Kntvntd482001!";          // Phải khớp với SECRET_KEY trong index.html
const DRIVE_FOLDER_ID = "1DHIBw5JG34-PaAb12AI_khZeZ50zqjsN";      // ID thư mục Drive để lưu video
const SPREADSHEET_ID  = "1uM5PemCsuBM2XNbRr9ME4aSC3nqwP5Fsutogsw6KcKI"; // ĐIỀN ID GOOGLE SHEET VÀO ĐÂY NẾU BẠN DÙNG SCRIPT ĐỘC LẬP (Lấy từ URL của file Sheet)
const SHEET_NAME      = "VideoLog"; // ĐIỀN TÊN TRANG TÍNH CHỨA VIDEO (Vd: "Trang tính 1" hoặc để trống để tự động lấy sheet đầu tiên)
//   Cách lấy: Mở thư mục Drive → URL trình duyệt sẽ có dạng
//   https://drive.google.com/drive/folders/1AbCdEfGhIj...
//   Lấy đoạn sau /folders/ là DRIVE_FOLDER_ID

// ============================================================
// ROUTER CHÍNH
// ============================================================
function doPost(e) {
  try {
    var req  = JSON.parse(e.postData.contents);
    var key  = req.key;
    var action = req.action;
    var data = req.data || {};

    if (key !== SECRET_KEY) {
      return json({ ok: false, error: "Sai SECRET_KEY." });
    }

    if (action === "getUploadUrl")     return handleGetUploadUrl(data);
    if (action === "uploadVideoChunk") return handleUploadChunk(data);
    if (action === "logVideo")         return handleLogVideo(data);
    if (action === "searchVideo")      return handleSearchVideo(data);
    if (action === "getRecentVideos")  return handleGetRecentVideos(data);
    if (action === "deleteVideo")      return handleDeleteVideo(data.trackingCode);

    return json({ ok: false, error: "Action không hợp lệ: " + action });
  } catch(err) {
    return json({ ok: false, error: "Lỗi hệ thống: " + err.toString() });
  }
}

function doGet(e) {
  return json({ ok: true, message: "VBC Apps Script đang hoạt động." });
}

// ============================================================
// 1. Mở phiên Resumable Upload — trả về uploadUrl cho Frontend
// ============================================================
function handleGetUploadUrl(data) {
  try {
    var fileName    = data.fileName    || ("video_" + Date.now() + ".webm");
    var mimeType    = data.mimeType    || "video/webm";

    var metadata = {
      name    : fileName,
      parents : [DRIVE_FOLDER_ID],
      mimeType: mimeType
    };

    var token = ScriptApp.getOAuthToken();
    var initRes = UrlFetchApp.fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        method      : "POST",
        headers     : {
          "Authorization" : "Bearer " + token,
          "Content-Type"  : "application/json; charset=UTF-8",
          "X-Upload-Content-Type"   : mimeType,
          "X-Upload-Content-Length" : data.fileSize || 0
        },
        payload     : JSON.stringify(metadata),
        muteHttpExceptions: true
      }
    );

    var uploadUrl = initRes.getHeaders()["Location"];
    if (!uploadUrl) {
      throw new Error("Drive không trả về Location header. Response: " + initRes.getContentText());
    }

    return json({ ok: true, uploadUrl: uploadUrl });
  } catch(err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ============================================================
// 2. Trung chuyển (Proxy) từng chunk video lên Drive API
// ============================================================
function handleUploadChunk(data) {
  try {
    var uploadUrl = data.uploadUrl;
    var base64Data = data.base64;
    var startByte = data.startByte;
    var chunkSize = data.chunkSize;
    var totalSize = data.totalSize;

    // Decode base64 sang byte array
    var blob = Utilities.base64Decode(base64Data);

    var endByte = startByte + chunkSize - 1;
    var contentRange = "bytes " + startByte + "-" + endByte + "/" + totalSize;

    var res = UrlFetchApp.fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": contentRange
      },
      payload: blob,
      muteHttpExceptions: true
    });

    var statusCode = res.getResponseCode();
    if (statusCode === 308) {
      // Chunk thành công, Drive báo cần gửi tiếp
      return json({ ok: true, status: 308 });
    } else if (statusCode === 200 || statusCode === 201) {
      // Hoàn tất file
      var resJson = JSON.parse(res.getContentText());
      return json({ ok: true, status: statusCode, fileId: resJson.id });
    } else {
      throw new Error("Lỗi Drive API: " + statusCode + " - " + res.getContentText());
    }
  } catch (err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ============================================================
// 3. Ghi log vào Sheet sau khi Frontend hoàn tất
// ============================================================
function handleLogVideo(data) {
  try {
    var sheet = getSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["fileName", "trackingCode", "uploadDate", "deleteDate", "fileId", "driveUrl"]);
    }
    
    var dateToStore = data.uploadDate || new Date().toISOString();
    var fileId = "";
    if (data.driveUrl) {
      var match = data.driveUrl.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      if (match && match[1]) fileId = match[1];
    }
    
    // Ghi đúng chuẩn cột: A=fileName, B=trackingCode, C=uploadDate, D=deleteDate, E=fileId, F=driveUrl
    sheet.appendRow([
      data.fileName     || "",
      data.trackingCode || "",
      dateToStore,
      "", // deleteDate (trống)
      fileId,
      data.driveUrl     || ""
    ]);
    return json({ ok: true, driveUrl: data.driveUrl });
  } catch(err) {
    return json({ ok: false, error: err.toString() });
  }
}

// Hàm đọc dữ liệu linh hoạt (tự sửa lỗi những dòng bị sai thứ tự cột)
function parseRow(row) {
  var fileName = row[0] || "";
  var trackingCode = row[1] || "";
  
  // Sửa lỗi dòng bị ngược (A=trackingCode, B=fileName) ở 3 video gần nhất
  if (String(fileName).indexOf('.webm') === -1 && String(fileName).indexOf('.mp4') === -1) {
    if (String(trackingCode).indexOf('.webm') > -1 || String(trackingCode).indexOf('.mp4') > -1) {
      var tmp = fileName; fileName = trackingCode; trackingCode = tmp;
    }
  }

  var driveUrl = row[5] || "";
  if (String(driveUrl).indexOf('drive.google.com') === -1) {
    // Nếu rỗng, dò tìm cột C hoặc các cột khác
    for (var c=2; c<row.length; c++) {
      if (row[c] && String(row[c]).indexOf('drive.google.com') > -1) { driveUrl = row[c]; break; }
    }
  }

  var uploadDate = serializeDate(row[2]);
  if (!uploadDate) {
    // Dò tìm ở cột D hoặc E (vì dữ liệu cũ bị shift cột)
    for (var c=3; c<row.length; c++) {
      var d2 = serializeDate(row[c]);
      if (d2 && String(row[c]).indexOf('drive.google.com') === -1) { uploadDate = d2; break; }
    }
  }
  
  return {
    trackingCode: String(trackingCode).trim(),
    fileName: String(fileName).trim(),
    driveUrl: String(driveUrl).trim(),
    uploadDate: uploadDate
  };
}

// ============================================================
// 4. Tìm kiếm video theo mã vận đơn
// ============================================================
function handleSearchVideo(data) {
  try {
    var sheet  = getSheet();
    var values = sheet.getDataRange().getValues();
    var code   = String(data.trackingCode || "").trim();

    for (var i = 1; i < values.length; i++) {
      var parsed = parseRow(values[i]);
      if (parsed.trackingCode === code) {
        return json({
          ok           : true,
          trackingCode : parsed.trackingCode,
          fileName     : parsed.fileName,
          driveUrl     : parsed.driveUrl,
          uploadDate   : parsed.uploadDate
        });
      }
    }
    return json({ ok: false, error: "Không tìm thấy mã vận đơn." });
  } catch(err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ============================================================
// 5. Lấy danh sách video gần đây
// ============================================================
function handleGetRecentVideos(data) {
  try {
    var sheet  = getSheet();
    var values = sheet.getDataRange().getValues();
    var limit  = data.limit || 5;
    
    var recent = [];
    for (var i = values.length - 1; i >= 1; i--) {
      var parsed = parseRow(values[i]);
      if (parsed.trackingCode !== "") {
        recent.push(parsed);
        if (recent.length >= limit) break;
      }
    }
    
    return json({ ok: true, videos: recent });
  } catch(err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ============================================================
// 6. Xóa video (Drive + Sheet)
// ============================================================
function handleDeleteVideo(trackingCode) {
  try {
    var sheet  = getSheet();
    var values = sheet.getDataRange().getValues();
    var code   = String(trackingCode || "").trim();

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === code) {
        var driveUrl = String(values[i][2] || "");
        var match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
        if (match && match[1]) {
          try {
            DriveApp.getFileById(match[1]).setTrashed(true);
          } catch(e) {
            console.warn("Không xóa được file Drive:", e);
          }
        }
        sheet.deleteRow(i + 1);
        return json({ ok: true });
      }
    }
    return json({ ok: false, error: "Không tìm thấy mã vận đơn để xóa." });
  } catch(err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ============================================================
// Helper
// ============================================================
function getSheet() { 
  var ss = null;
  if (SPREADSHEET_ID && SPREADSHEET_ID.trim() !== "") {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID.trim());
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  
  if (!ss) {
    throw new Error("Không thể kết nối với Google Sheet. Vui lòng điền SPREADSHEET_ID ở đầu file Code.gs.");
  }
  
  if (SHEET_NAME && SHEET_NAME.trim() !== "") {
    var sheet = ss.getSheetByName(SHEET_NAME.trim());
    if (sheet) return sheet;
  }
  
  // Đọc sheet theo tên "Data" hoặc "Trang tính1", nếu không có thì lấy sheet đầu tiên
  return ss.getSheetByName("Data") || ss.getSheetByName("Trang tính1") || ss.getSheetByName("Sheet1") || ss.getSheetByName("Trang tính 1") || ss.getSheets()[0]; 
}
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/**
 * serializeDate: chuẩn hoá giá trị ngày giờ về ISO string.
 * Xử lý các trường hợp:
 *  - Date object (Google Sheets trả về khi cell là Date)
 *  - ISO string: "2026-07-11T01:30:47.000Z"
 *  - Locale VN string: "11/07/2026 1:30:47" (DD/MM/YYYY HH:MM:SS)  ← dữ liệu cũ bị lưu sai
 *  - Rỗng / null
 */
function serializeDate(val) {
  if (!val) return null;
  
  // Nếu là Date object (Sheets trả về kiểu này khi cell được nhận dạng là Date)
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val.toISOString();
  }
  
  var s = String(val).trim();
  if (s === "" || s === "undefined" || s === "null") return null;
  
  // Thử parse thẳng (ISO format hoặc en-US format)
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  
  // Thử parse dạng DD/MM/YYYY HH:MM:SS (locale VN — dữ liệu cũ bị lưu sai)
  // Ví dụ: "11/07/2026 1:30:47" hoặc "11/07/2026, 1:30:47"
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    var day   = parseInt(m[1], 10);
    var month = parseInt(m[2], 10) - 1; // JS month 0-indexed
    var year  = parseInt(m[3], 10);
    var hour  = parseInt(m[4], 10);
    var min   = parseInt(m[5], 10);
    var sec   = m[6] ? parseInt(m[6], 10) : 0;
    var parsed = new Date(year, month, day, hour, min, sec);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  
  // Không parse được, trả về null để frontend hiển thị "Không rõ"
  return null;
}