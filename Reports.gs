function getReportsPageMeta(token) {
  var session = assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  var reportTypes = getAllowedReportTypesForRole_(session.role);
  return successResponse_({
    module: "Reports",
    supportedExports: ["pdf", "excel"],
    reportTypes: reportTypes,
    defaultPageSize: 10,
  });
}

function getReportsData(reportType, filters, token) {
  Logger.log(
    "[getReportsData] reportType: " +
      typeof reportType +
      " (" +
      JSON.stringify(reportType) +
      "), filters: " +
      JSON.stringify(filters),
  );
  try {
    assertReportAccess_(reportType, token);
    var payload = buildReportPayload_(reportType, filters);
    return successResponse_(payload);
  } catch (error) {
    return errorResponse_(error.message || "Unable to load report data.");
  }
}

function exportReport(reportType, format, filters, token) {
  try {
    var type = "";
    if (typeof reportType === "string") {
      type = reportType.trim().toLowerCase();
    } else if (reportType && typeof reportType === "object") {
      type = (reportType.type || reportType.reportType || "")
        .trim()
        .toLowerCase();
    }
    if (!type) {
      type = "daily-sales";
    }

    assertReportAccess_(type, token);
    var exportType = normalizeText_(format || "pdf").toLowerCase();
    var reportData = buildReportPayload_(type, filters);
    var stamp = Utilities.formatDate(
      new Date(),
      APP_CONFIG.timezone,
      "yyyyMMdd_HHmmss",
    );
    var fileName =
      (reportData.title || "Report").replace(/\s+/g, "_") + "_" + stamp;

    if (exportType === "excel") {
      return exportReportExcel_(reportData, fileName);
    }

    if (exportType === "pdf") {
      return exportReportPdf_(reportData, fileName);
    }

    return errorResponse_("Unsupported export format.");
  } catch (error) {
    return errorResponse_(error.message || "Unable to export report.");
  }
}

function buildReportPayload_(reportType, filters) {
  var type = "";
  if (typeof reportType === "string") {
    type = reportType.trim().toLowerCase();
  } else if (reportType && typeof reportType === "object") {
    type = (reportType.type || reportType.reportType || "")
      .trim()
      .toLowerCase();
  }
  if (!type) {
    type = "sales";
  }

  Logger.log("[buildReportPayload_] Resolved type: " + type);
  var normalizedFilters = normalizeReportFilters_(filters);
  var items = getItemRecords_();
  var generatedAt = new Date().toISOString();

  if (type === "purchases") {
    return buildPurchaseReportPayload_(items, normalizedFilters, generatedAt);
  }

  if (type === "lowstock") {
    return buildLowStockReportPayload_(items, generatedAt);
  }

  return buildSalesReportPayload_(items, normalizedFilters, generatedAt);
}

function getAllowedReportTypesForRole_(role) {
  return ["sales", "purchases", "lowstock"];
}

function assertReportAccess_(reportType, token) {
  var session = assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  var type = normalizeText_(reportType).toLowerCase() || "sales";
  var allowed = getAllowedReportTypesForRole_(session.role);

  if (allowed.indexOf(type) === -1) {
    throw new Error("Access denied: this report is restricted.");
  }

  return session;
}

function normalizeReportFilters_(filters) {
  filters = filters || {};

  return {
    dateFrom: normalizeText_(filters.dateFrom),
    dateTo: normalizeText_(filters.dateTo),
  };
}

function buildSalesReportPayload_(items, filters, generatedAt) {
  var sales = getSalesRecords_()
    .filter(function (sale) {
      return isActiveTransactionStatus_(sale.status);
    })
    .filter(function (sale) {
      return isWithinDateRange_(
        sale.saleDate,
        filters.dateFrom,
        filters.dateTo,
      );
    });

  var itemMap = {};
  items.forEach(function (item) {
    itemMap[item.id] = item;
  });

  var rows = [];
  sales.forEach(function (sale) {
    var saleItems = sale.items || [];
    saleItems.forEach(function (saleItem) {
      var itemName =
        (itemMap[saleItem.itemId] && itemMap[saleItem.itemId].name) ||
        saleItem.itemId;
      rows.push({
        saleDate: sale.saleDate,
        display: [
          sale.invoiceNumber || "-",
          itemName,
          saleItem.itemId,
          saleItem.quantity,
          formatCurrency_(saleItem.unitPrice),
          formatCurrency_(saleItem.totalPrice),
          sale.saleDate || "-",
        ],
        export: [
          sale.invoiceNumber || "-",
          itemName,
          saleItem.itemId,
          saleItem.quantity,
          toNumber_(saleItem.unitPrice),
          toNumber_(saleItem.totalPrice),
          sale.saleDate || "-",
        ],
      });
    });
  });

  rows.sort(function (a, b) {
    return compareReportDatesDesc_(a.saleDate, b.saleDate);
  });

  var totalAmount = sales.reduce(function (t, s) {
    return t + toNumber_(s.totalAmount);
  }, 0);

  return createReportPayload_({
    reportType: "sales",
    title: "Sales Report",
    summaryLabel: "Total Sales",
    summaryValue: totalAmount,
    summaryValueDisplay: formatCurrency_(totalAmount),
    columns: [
      "Invoice",
      "Item Name",
      "Item ID",
      "Quantity",
      "Unit Price",
      "Total Price",
      "Sale Date",
    ],
    rows: rows,
    generatedAt: generatedAt,
    filters: filters,
  });
}

function buildPurchaseReportPayload_(items, filters, generatedAt) {
  var itemMap = {};
  items.forEach(function (item) {
    itemMap[item.id] = item;
  });

  var purchases = getPurchaseRecords_()
    .filter(function (purchase) {
      return isActiveTransactionStatus_(purchase.status || "completed");
    })
    .filter(function (purchase) {
      return isWithinDateRange_(
        purchase.purchaseDate,
        filters.dateFrom,
        filters.dateTo,
      );
    })
    .sort(function (a, b) {
      return compareReportDatesDesc_(a.purchaseDate, b.purchaseDate);
    });

  var totalPurchases = sumByField_(purchases, "totalCost");
  var rows = purchases.map(function (purchase) {
    var item = itemMap[purchase.itemId] || {};

    return {
      display: [
        purchase.id,
        item.name || purchase.itemId,
        purchase.supplier || "-",
        purchase.quantity,
        formatCurrency_(purchase.unitPrice),
        formatCurrency_(purchase.totalCost),
        purchase.purchaseDate || "-",
      ],
      export: [
        purchase.id,
        item.name || purchase.itemId,
        purchase.supplier || "-",
        purchase.quantity,
        toNumber_(purchase.unitPrice),
        toNumber_(purchase.totalCost),
        purchase.purchaseDate || "-",
      ],
    };
  });

  return createReportPayload_({
    reportType: "purchases",
    title: "Purchase Report",
    summaryLabel: "Total Purchases",
    summaryValue: formatCurrency_(totalPurchases),
    summaryValueDisplay: formatCurrency_(totalPurchases),
    columns: [
      "ID",
      "Item",
      "Supplier",
      "Quantity",
      "Unit Price",
      "Total Cost",
      "Date",
    ],
    rows: rows,
    generatedAt: generatedAt,
    filters: filters,
  });
}

// Inventory report removed

function buildLowStockReportPayload_(items, generatedAt) {
  var lowStockItems = items
    .filter(function (item) {
      return item.currentStock <= item.minimumStock;
    })
    .sort(function (a, b) {
      var shortageA = Math.max(a.minimumStock - a.currentStock, 0);
      var shortageB = Math.max(b.minimumStock - b.currentStock, 0);

      if (shortageB !== shortageA) {
        return shortageB - shortageA;
      }

      return normalizeText_(a.name).localeCompare(normalizeText_(b.name));
    });

  var rows = lowStockItems.map(function (item) {
    return {
      display: [
        item.id,
        item.name,
        item.category || "Uncategorized",
        item.currentStock,
        item.minimumStock,
        Math.max(item.minimumStock - item.currentStock, 0),
      ],
      export: [
        item.id,
        item.name,
        item.category || "Uncategorized",
        item.currentStock,
        item.minimumStock,
        Math.max(item.minimumStock - item.currentStock, 0),
      ],
    };
  });

  return createReportPayload_({
    reportType: "lowstock",
    title: "Low Stock Report",
    summaryLabel: "Low Stock Items",
    summaryValue: lowStockItems.length,
    summaryValueDisplay: String(lowStockItems.length),
    columns: [
      "ID",
      "Item",
      "Category",
      "Current Stock",
      "Minimum Stock",
      "Shortage",
    ],
    rows: rows,
    generatedAt: generatedAt,
    filters: {},
  });
}

function createReportPayload_(config) {
  var rowEntries = config.rows || [];

  return {
    reportType: config.reportType,
    title: config.title,
    summaryLabel: config.summaryLabel,
    summaryValue: config.summaryValue,
    summaryValueDisplay:
      config.summaryValueDisplay || String(config.summaryValue),
    columns: config.columns || [],
    rows: rowEntries.map(function (entry) {
      return entry.display;
    }),
    exportRows: rowEntries.map(function (entry) {
      return entry.export;
    }),
    totalRecords: rowEntries.length,
    generatedAt: config.generatedAt,
    filters: config.filters || {},
  };
}

function compareReportDatesDesc_(leftDate, rightDate) {
  var left = parseReportDate_(leftDate);
  var right = parseReportDate_(rightDate);
  var leftTime = left ? left.getTime() : 0;
  var rightTime = right ? right.getTime() : 0;
  return rightTime - leftTime;
}

function getOrCreateExportsFolder_() {
  var folderName = "IMS_Exports";
  var folders = DriveApp.getFoldersByName(folderName);
  var folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder(folderName);
  }
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return folder;
}

function exportReportExcel_(reportData, fileName) {
  var spreadsheet = SpreadsheetApp.create(fileName);
  var sheet = spreadsheet.getSheets()[0];

  sheet.setName("Report");
  sheet.getRange(1, 1).setValue(reportData.title || "Report");
  sheet.getRange(2, 1).setValue("Generated: " + formatDateTime_(new Date()));
  sheet
    .getRange(3, 1)
    .setValue(
      (reportData.summaryLabel || "Summary") +
        ": " +
        (reportData.summaryValueDisplay || reportData.summaryValue),
    );

  var headerRow = 5;
  var columns = reportData.columns || [];
  var exportRows = reportData.exportRows || [];

  if (columns.length) {
    sheet
      .getRange(headerRow, 1, 1, columns.length)
      .setValues([columns])
      .setFontWeight("bold");
  }

  if (exportRows.length && columns.length) {
    sheet
      .getRange(headerRow + 1, 1, exportRows.length, columns.length)
      .setValues(exportRows);
  }

  if (columns.length) {
    sheet.autoResizeColumns(1, columns.length);
  }

  SpreadsheetApp.flush();

  var tempFile = DriveApp.getFileById(spreadsheet.getId());
  var excelBlob = tempFile.getAs(MimeType.MICROSOFT_EXCEL);

  tempFile.setTrashed(true);

  var folder = getOrCreateExportsFolder_();
  var excelFile = folder.createFile(excelBlob);
  excelFile.setName(fileName + ".xlsx");
  excelFile.setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW,
  );

  return successResponse_(
    {
      fileUrl: excelFile.getDownloadUrl(),
      fileName: fileName + ".xlsx",
    },
    "Export ready.",
  );
}

function exportReportPdf_(reportData, fileName) {
  var html = buildReportHtml_(reportData);
  var pdfBlob = HtmlService.createHtmlOutput(html).getAs("application/pdf");

  var folder = getOrCreateExportsFolder_();
  var pdfFile = folder.createFile(pdfBlob);
  pdfFile.setName(fileName + ".pdf");
  pdfFile.setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW,
  );

  return successResponse_(
    {
      fileUrl: pdfFile.getDownloadUrl(),
      fileName: fileName + ".pdf",
    },
    "Export ready.",
  );
}

function buildReportHtml_(reportData) {
  var columns = reportData.columns || [];
  var rows = reportData.rows || [];
  var headerCells = columns
    .map(function (column) {
      return "<th>" + escapeHtml_(column) + "</th>";
    })
    .join("");
  var bodyRows = rows
    .map(function (row) {
      var cells = row
        .map(function (cell) {
          return "<td>" + escapeHtml_(cell) + "</td>";
        })
        .join("");
      return "<tr>" + cells + "</tr>";
    })
    .join("");
  var filterSummary = buildReportFilterSummary_(reportData.filters);

  return (
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    "body{font-family:Arial,sans-serif;color:#111827;margin:24px;}" +
    "h1{margin:0 0 8px;font-size:24px;}" +
    ".meta{color:#6b7280;font-size:12px;margin-bottom:18px;}" +
    ".summary{margin:0 0 18px;font-size:14px;}" +
    "table{border-collapse:collapse;width:100%;font-size:12px;}" +
    "th,td{border:1px solid #d1d5db;padding:8px;text-align:left;}" +
    "th{background:#f3f4f6;}" +
    "</style></head><body>" +
    "<h1>" +
    escapeHtml_(reportData.title || "Report") +
    "</h1>" +
    '<p class="meta">' +
    escapeHtml_(APP_CONFIG.name) +
    " · Generated " +
    escapeHtml_(formatDateTime_(new Date())) +
    "</p>" +
    (filterSummary
      ? '<p class="meta">' + escapeHtml_(filterSummary) + "</p>"
      : "") +
    '<p class="summary"><strong>' +
    escapeHtml_(reportData.summaryLabel || "Summary") +
    ":</strong> " +
    escapeHtml_(reportData.summaryValueDisplay || reportData.summaryValue) +
    "</p>" +
    "<table><thead><tr>" +
    headerCells +
    "</tr></thead><tbody>" +
    bodyRows +
    "</tbody></table>" +
    "</body></html>"
  );
}

function buildReportFilterSummary_(filters) {
  filters = filters || {};
  var fromDate = normalizeText_(filters.dateFrom);
  var toDate = normalizeText_(filters.dateTo);

  if (!fromDate && !toDate) {
    return "";
  }

  if (fromDate && toDate) {
    return "Date range: " + fromDate + " to " + toDate;
  }

  if (fromDate) {
    return "Date from: " + fromDate;
  }

  return "Date to: " + toDate;
}

// sumInventoryValue_ removed
