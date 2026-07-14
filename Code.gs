// ============================================================
// CẤU HÌNH — Sửa 2 giá trị này cho đúng với tài khoản của bạn
// ============================================================
const SECRET_KEY      = "Kntvntd482001!";          // Phải khớp với SECRET_KEY trong index.html
const DRIVE_FOLDER_ID = "1DHIBw5JG34-PaAb12AI_khZeZ50zqjsN";      // ID thư mục Drive để lưu video
const SPREADSHEET_ID  = ""; // ĐIỀN ID GOOGLE SHEET VÀO ĐÂY NẾU BẠN DÙNG SCRIPT ĐỘC LẬP (Lấy từ URL của file Sheet)
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
      sheet.appendRow(["Mã vận đơn", "Tên file", "Link Drive", "Ngày giờ upload"]);
    }
    sheet.appendRow([
      data.trackingCode || "",
      data.fileName     || "",
      data.driveUrl     || "",
      data.uploadDate   ? new Date(data.uploadDate).toLocaleString("vi-VN") : new Date().toLocaleString("vi-VN")
    ]);
    return json({ ok: true, driveUrl: data.driveUrl });
  } catch(err) {
    return json({ ok: false, error: err.toString() });
  }
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
      if (String(values[i][0]).trim() === code) {
        return json({
          ok           : true,
          trackingCode : values[i][0],
          fileName     : values[i][1],
          driveUrl     : values[i][2],
          uploadDate   : values[i][3]
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
    // Đọc từ dưới lên, bắt đầu từ dòng cuối cùng của DataRange, bỏ qua dòng 1 (tiêu đề)
    for (var i = values.length - 1; i >= 1; i--) {
      var row = values[i];
      // Chỉ lấy các dòng có mã vận đơn (không bị rỗng)
      if (String(row[0]).trim() !== "") {
        recent.push({
          trackingCode: row[0],
          fileName:     row[1],
          driveUrl:     row[2],
          uploadDate:   row[3]
        });
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
  
  // Đọc sheet theo tên "Data" hoặc "Trang tính1", nếu không có thì lấy sheet đầu tiên
  return ss.getSheetByName("Data") || ss.getSheetByName("Trang tính1") || ss.getSheetByName("Sheet1") || ss.getSheetByName("Trang tính 1") || ss.getSheets()[0]; 
}
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }