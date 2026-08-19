/* ================================================================
   PERFORMANCE: Caching Layer
   - Uses CacheService.getScriptCache() with configurable TTL
   - Cache keys are prefixed to avoid collisions
   - Cache is invalidated on any create/update/delete operation
   ================================================================ */

var CACHE_ = (function () {
  var PREFIX = "ims_";
  var DEFAULT_TTL_SECONDS = 15; // 15 seconds for real-time feel

  function getCache_() {
    return CacheService.getScriptCache();
  }

  function get_(key) {
    try {
      var val = getCache_().get(PREFIX + key);
      return val ? JSON.parse(val) : null;
    } catch (e) {
      return null;
    }
  }

  function put_(key, value, ttlSeconds) {
    try {
      getCache_().put(
        PREFIX + key,
        JSON.stringify(value),
        ttlSeconds || DEFAULT_TTL_SECONDS,
      );
    } catch (e) {
      // Cache failures are non-critical
    }
  }

  function remove_(key) {
    try {
      getCache_().remove(PREFIX + key);
    } catch (e) {}
  }

  return {
    get: get_,
    put: put_,
    remove: remove_,
    removeAll: function (keys) {
      if (!keys || !keys.length) return;
      var prefixed = keys.map(function (k) {
        return PREFIX + k;
      });
      try {
        getCache_().removeAll(prefixed);
      } catch (e) {}
    },
    invalidateAll: function () {
      // Remove known cache keys
      var keys = [
        "itemRecords",
        "purchaseRecords",
        "salesRecords",
        "saleItemsRecords",
        "allocationRecords",
        "itemMap",
        "stockMap",
        "suppliers",
        "customers",
      ];
      this.removeAll(keys);
    },
  };
})();

function getCachedRecords_(cacheKey, sheetName, headers, forceRefresh) {
  if (forceRefresh) {
    CACHE_.remove(cacheKey);
  }

  var cached = CACHE_.get(cacheKey);
  if (cached) {
    return cached;
  }

  var records = getSheetRecords_(sheetName, headers);
  CACHE_.put(cacheKey, records);
  return records;
}

function invalidateDataCache_() {
  CACHE_.invalidateAll();
}

function successResponse_(data, message) {
  return {
    success: true,
    message: message || "",
    data: data === undefined ? null : data,
  };
}

function errorResponse_(message, details) {
  return {
    success: false,
    message: message || "An unexpected error occurred.",
    details: details || null,
  };
}

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(sheetName, headers) {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (headers && headers.length > 0 && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else if (headers && headers.length > 0 && sheet.getLastRow() >= 1) {
    syncEmptySheetHeaders_(sheet, headers);
  }

  return sheet;
}

function syncEmptySheetHeaders_(sheet, headers) {
  var currentHeaders = sheet
    .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length))
    .getValues()[0];
  var normalizedCurrent = currentHeaders
    .slice(0, headers.length)
    .map(normalizeText_);
  var normalizedNext = headers.map(normalizeText_);
  var headersMatch =
    normalizedNext.every(function (header, index) {
      return header === normalizedCurrent[index];
    }) && normalizeText_(currentHeaders[headers.length]) === "";

  if (headersMatch) {
    return;
  }

  var headerWidth = Math.max(sheet.getLastColumn(), headers.length);
  sheet.getRange(1, 1, 1, headerWidth).clearContent();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function getSheetRecords_(sheetName, headers) {
  var sheet = getOrCreateSheet_(sheetName, headers || []);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  var headerRow = values[0].map(function (header) {
    return normalizeText_(header);
  });

  return values
    .slice(1)
    .filter(function (row) {
      return row.some(function (cell) {
        return normalizeText_(cell) !== "";
      });
    })
    .map(function (row, rowIndex) {
      var record = {
        _rowNumber: rowIndex + 2,
      };

      headerRow.forEach(function (header, index) {
        if (header) {
          record[header] = row[index];
        }
      });

      return record;
    });
}

function repairInventoryHeaders() {
  setSheetHeadersOnly_("Items", getItemsHeaders_());
  setSheetHeadersOnly_("Purchases", getPurchasesHeaders_());
  setSheetHeadersOnly_("Sales", getSalesHeaders_());

  return successResponse_(
    {
      repairedSheets: ["Items", "Purchases", "Sales"],
    },
    "Inventory headers repaired.",
  );
}

function setSheetHeadersOnly_(sheetName, headers) {
  var sheet = getOrCreateSheet_(sheetName, []);
  var headerWidth = Math.max(sheet.getLastColumn(), headers.length);

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      headers.length - sheet.getMaxColumns(),
    );
  }

  sheet.getRange(1, 1, 1, headerWidth).clearContent();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function toNumber_(value) {
  // Handles: numbers, numeric strings, thousands separators, and decimal commas.
  // Prevents date-like strings (e.g. "1900-07-18") from being coerced into numbers.
  if (value === null || value === undefined) return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  var text = String(value).trim();
  if (!text) return 0;

  // If it looks like an ISO date, treat as 0 to avoid accidental numeric coercion.
  // (e.g. "1900-07-18" -> Number("1900-07-18") => 1900)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 0;

  // Normalize thousands separators and decimal separators:
  // - If both "," and "." exist, assume thousands separator is "," and decimal is "."
  // - If only "," exists, assume it's the decimal separator.
  var normalized;
  if (text.includes(",") && text.includes(".")) {
    normalized = text.replace(/,/g, ""); // "1,234.56" => "1234.56"
  } else if (text.includes(",") && !text.includes(".")) {
    normalized = text.replace(/,/g, "."); // "123,45" => "123.45"
  } else {
    normalized = text; // "123.45" or "123"
  }

  // Extract first numeric token to be extra defensive.
  var match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) return 0;

  var numberValue = Number(match[0]);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toIsoDate_(value) {
  if (
    Object.prototype.toString.call(value) === "[object Date]" &&
    !isNaN(value.getTime())
  ) {
    return value.toISOString();
  }

  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function isActiveRecord_(record) {
  var status = normalizeText_(record.Status || record.status).toLowerCase();
  return (
    status === "" ||
    status === "active" ||
    status === "completed" ||
    status === "paid"
  );
}

function isActiveTransactionStatus_(status) {
  var normalized = normalizeText_(status).toLowerCase();
  return (
    normalized === "" ||
    normalized === "active" ||
    normalized === "completed" ||
    normalized === "paid"
  );
}

function normalizeText_(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function formatDateTime_(date) {
  return Utilities.formatDate(
    date || new Date(),
    APP_CONFIG.timezone,
    "yyyy-MM-dd HH:mm:ss",
  );
}

function formatSheetDate_(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return Utilities.formatDate(value, APP_CONFIG.timezone, "yyyy-MM-dd");
  }
  var s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, APP_CONFIG.timezone, "yyyy-MM-dd");
  }
  return s;
}

function formatCurrency_(value) {
  return (
    "\u20A8 " +
    toNumber_(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function sumByField_(records, fieldName) {
  return records.reduce(function (total, record) {
    return total + toNumber_(record[fieldName]);
  }, 0);
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseReportDate_(value) {
  var text = normalizeText_(value);

  if (!text) {
    return null;
  }

  var parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function startOfDay_(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

function endOfDay_(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();
}

function isWithinDateRange_(value, fromDate, toDate) {
  var from = normalizeText_(fromDate);
  var to = normalizeText_(toDate);

  if (!from && !to) {
    return true;
  }

  var parsed = parseReportDate_(value);

  if (!parsed) {
    return false;
  }

  var time = parsed.getTime();

  if (from) {
    var fromParsed = parseReportDate_(from);

    if (fromParsed && time < startOfDay_(fromParsed)) {
      return false;
    }
  }

  if (to) {
    var toParsed = parseReportDate_(to);

    if (toParsed && time > endOfDay_(toParsed)) {
      return false;
    }
  }

  return true;
}

function createExportDownloadResponse_(blob, fileName, mimeType) {
  return successResponse_(
    {
      fileName: fileName,
      mimeType: mimeType,
      contentBase64: Utilities.base64Encode(blob.getBytes()),
      downloadMethod: "base64",
    },
    "Export ready.",
  );
}
