/* ============================================================
   SETTINGS MODULE — Settings.gs
   Manages company profile, currency (PKR), tax, invoice prefix,
   logo URL, and system toggles stored in the Settings sheet.
   ============================================================ */

var SETTINGS_SHEET_NAME_ = "Settings";

var SETTINGS_HEADERS_ = ["Key", "Value", "UpdatedAt"];

var SETTINGS_DEFAULTS_ = {
  companyName: "My Company",
  companyEmail: "",
  companyPhone: "",
  companyAddress: "",
  logoUrl: "",
  currency: "PKR",
  currencySymbol: "₨",
  taxLabel: "GST",
  taxRate: "0",
  invoicePrefix: "INV-",
  invoiceNextNo: "1001",
  timezone: "Asia/Karachi",
  dateFormat: "dd/MM/yyyy",
  lowStockAlert: "true",
  darkMode: "false",
  language: "en",
};

/* ---- Public API ---- */

function getSettings(token) {
  try {
    assertAdminRole_(token);
    var stored = loadSettingsMap_();
    var settings = mergeWithDefaults_(stored);
    return successResponse_(settings, "Settings loaded.");
  } catch (e) {
    return errorResponse_(e.message || "Unable to load settings.");
  }
}

function saveSettings(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    assertAdminRole_(token);
    var data = payload || {};
    var validKeys = Object.keys(SETTINGS_DEFAULTS_);
    var sheet = getSettingsSheet_();
    var now = formatDateTime_(new Date());
    var stored = loadSettingsMap_();

    validKeys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        var value = normalizeText_(data[key]);
        stored[key] = value;
        upsertSettingsRow_(sheet, key, value, now);
      }
    });

    var merged = mergeWithDefaults_(stored);
    return successResponse_(merged, "Settings saved successfully.");
  } catch (e) {
    return errorResponse_(e.message || "Unable to save settings.");
  } finally {
    lock.releaseLock();
  }
}

function resetSettings(token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    assertAdminRole_(token);
    var sheet = getSettingsSheet_();
    var now = formatDateTime_(new Date());

    Object.keys(SETTINGS_DEFAULTS_).forEach(function (key) {
      upsertSettingsRow_(sheet, key, SETTINGS_DEFAULTS_[key], now);
    });

    return successResponse_(SETTINGS_DEFAULTS_, "Settings reset to defaults.");
  } catch (e) {
    return errorResponse_(e.message || "Unable to reset settings.");
  } finally {
    lock.releaseLock();
  }
}

/* ---- Sheet helpers ---- */

function getSettingsSheet_() {
  return getOrCreateSheet_(SETTINGS_SHEET_NAME_, SETTINGS_HEADERS_);
}

function loadSettingsMap_() {
  var records = getSheetRecords_(SETTINGS_SHEET_NAME_, SETTINGS_HEADERS_);
  var map = {};
  records.forEach(function (r) {
    var key = normalizeText_(r.Key);
    if (key) {
      map[key] = normalizeText_(r.Value);
    }
  });
  return map;
}

function mergeWithDefaults_(stored) {
  var merged = {};
  Object.keys(SETTINGS_DEFAULTS_).forEach(function (key) {
    merged[key] = Object.prototype.hasOwnProperty.call(stored, key)
      ? stored[key]
      : SETTINGS_DEFAULTS_[key];
  });
  return merged;
}

function upsertSettingsRow_(sheet, key, value, now) {
  var records = getSheetRecords_(SETTINGS_SHEET_NAME_, SETTINGS_HEADERS_);
  var found = null;

  for (var i = 0; i < records.length; i++) {
    if (normalizeText_(records[i].Key) === key) {
      found = records[i];
      break;
    }
  }

  if (found) {
    sheet.getRange(found._rowNumber, 2, 1, 2).setValues([[value, now]]);
  } else {
    sheet.appendRow([key, value, now]);
  }
}
