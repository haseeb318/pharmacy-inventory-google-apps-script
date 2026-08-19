/* ================================================================
   PERFORMANCE: Optimized Dashboard
   - Uses cached records via getCachedRecords_() 
   - Computes KPIs and summaries without full record mapping
   - Loads only recent 5-8 records instead of all 3000+
   - Falls back to legacy approach if fast approach fails
   ================================================================ */

function getDashboardOverview(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  try {
    return successResponse_(getDashboardOverviewFallback_());
  } catch (error) {
    return errorResponse_(
      error.message || "Unable to compute dashboard overview.",
    );
  }
}

function tryFastDashboard_() {
  var itemsSheet = getOrCreateSheet_("Items", getItemsHeaders_());
  var salesSheet = getOrCreateSheet_("Sales", getSalesHeaders_());
  var purchasesSheet = getOrCreateSheet_("Purchases", getPurchasesHeaders_());

  // Quick validation - sheets must have data
  if (itemsSheet.getLastRow() < 1) return null;

  var kpis = computeDashboardKpisFast_(itemsSheet, salesSheet, purchasesSheet);
  var recentSales = getRecentSalesFast_(salesSheet).slice(0, 5);
  var recentPurchases = getRecentPurchasesFast_(purchasesSheet).slice(0, 5);
  var lowStock = getLowStockItemsFromItemsSheet_(itemsSheet).slice(0, 8);
  var expiring = getExpiringBatchesFast_(purchasesSheet, itemsSheet).slice(
    0,
    8,
  );

  return {
    generatedAt: new Date().toISOString(),
    kpis: kpis,
    recentSales: recentSales,
    recentPurchases: recentPurchases,
    lowStockItems: lowStock,
    expiringBatches: expiring,
    chartSummary: {
      salesCount: kpis.salesCount || 0,
      purchasesCount: kpis.purchasesCount || 0,
      salesTotal: kpis.totalSales || 0,
      purchasesTotal: kpis.totalPurchases || 0,
    },
  };
}

/* ================================================================
   Fallback dashboard using cached records with hash maps
   More reliable than fast approach (handles header mismatches)
   ================================================================ */
function getDashboardOverviewFallback_() {
  var items = getItemRecords_();
  var sales = getSalesRecords_();
  var purchases = getPurchaseRecords_();

  var stockMap = buildItemStockMap_();
  var itemMap = buildItemLookupMap_();

  // Compute KPIs using maps
  var totalSales = sales.reduce(function (t, s) {
    return t + toNumber_(s.totalPrice || s.totalAmount);
  }, 0);
  var totalPurchases = purchases.reduce(function (t, p) {
    return t + toNumber_(p.totalCost);
  }, 0);

  // Low stock: iterate items once using stock map
  var lowStockItems = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var minStock = toNumber_(item.minimumStock);
    var currentStock =
      item.currentStock !== undefined
        ? toNumber_(item.currentStock)
        : stockMap[item.id] || 0;
    if (minStock > 0 && currentStock <= minStock) {
      lowStockItems.push({
        itemId: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit || "",
        currentStock: currentStock,
        minimumStock: minStock,
        shortage: Math.max(minStock - currentStock, 0),
      });
    }
  }
  lowStockItems.sort(function (a, b) {
    return b.shortage - a.shortage;
  });

  // Recent sales (last 5)
  var recentSales = sales
    .map(function (s) {
      return {
        id: s.invoiceNumber || s.id,
        date: s.saleDate || s.createdAt || "",
        partyName: s.customerName || "Walk-in",
        totalAmount: toNumber_(s.totalPrice || s.totalAmount),
        status: s.status || "Completed",
      };
    })
    .sort(function (a, b) {
      var dateA = a.date ? new Date(a.date).getTime() : 0;
      var dateB = b.date ? new Date(b.date).getTime() : 0;
      if (isNaN(dateA)) dateA = 0;
      if (isNaN(dateB)) dateB = 0;
      return dateB - dateA;
    })
    .slice(0, 5);

  // Recent purchases (last 5)
  var recentPurchases = purchases
    .map(function (p) {
      return {
        id: p.id,
        date: p.purchaseDate || p.createdAt || "",
        partyName: p.supplier || "Unknown",
        totalAmount: toNumber_(p.totalCost),
        status: "Completed",
      };
    })
    .sort(function (a, b) {
      var dateA = a.date ? new Date(a.date).getTime() : 0;
      var dateB = b.date ? new Date(b.date).getTime() : 0;
      if (isNaN(dateA)) dateA = 0;
      if (isNaN(dateB)) dateB = 0;
      return dateB - dateA;
    })
    .slice(0, 5);

  // Expiring batches (single pass)
  var now = new Date().getTime();
  var threshold = now + 60 * 24 * 60 * 60 * 1000;
  var expiringBatches = [];
  for (var pi = 0; pi < purchases.length; pi++) {
    var p = purchases[pi];
    if (toNumber_(p.remainingQuantity) <= 0 || !p.expiryDate) continue;
    var expTime = new Date(p.expiryDate).getTime();
    if (!isNaN(expTime) && expTime <= threshold) {
      var item = itemMap[p.itemId];
      var daysLeft = Math.ceil((expTime - now) / (1000 * 60 * 60 * 24));
      expiringBatches.push({
        batchNumber: p.batchNumber || p.id,
        itemId: p.itemId,
        itemName: item ? item.name : "Unknown",
        remainingQuantity: toNumber_(p.remainingQuantity),
        expiryDate: p.expiryDate,
        daysToExpiry: daysLeft,
      });
    }
  }
  expiringBatches.sort(function (a, b) {
    return a.daysToExpiry - b.daysToExpiry;
  });

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalItems: items.length,
      totalSales: totalSales,
      totalPurchases: totalPurchases,
      lowStockItems: lowStockItems.length,
    },
    recentSales: recentSales.slice(0, 5),
    recentPurchases: recentPurchases.slice(0, 5),
    lowStockItems: lowStockItems.slice(0, 8),
    expiringBatches: expiringBatches.slice(0, 8),
    chartSummary: {
      salesCount: sales.length,
      purchasesCount: purchases.length,
      salesTotal: totalSales,
      purchasesTotal: totalPurchases,
    },
  };
}

/* ================================================================
   PERFORMANCE: Fast KPI computation directly from sheet ranges
   Avoids full record mapping for simple aggregations
   Uses dynamic column finding via headers to avoid position bugs
   ================================================================ */
function computeDashboardKpisFast_(itemsSheet, salesSheet, purchasesSheet) {
  var totalItems = Math.max(0, itemsSheet.getLastRow() - 1);

  // Read sales totals by finding the right column via headers
  var totalSales = 0;
  var salesCount = 0;
  try {
    var salesCols = getColumnIndicesByHeaders_(salesSheet);
    var salesTotalCol = salesCols["TotalAmount"] || salesCols["TotalPrice"];
    var salesDataRows = Math.max(0, salesSheet.getLastRow() - 1);
    if (salesTotalCol !== undefined && salesDataRows > 0) {
      var salesData = salesSheet
        .getRange(2, salesTotalCol + 1, salesDataRows, 1)
        .getValues();
      for (var s = 0; s < salesData.length; s++) {
        var val = toNumber_(salesData[s] && salesData[s][0]);
        totalSales += val;
      }
      salesCount = salesDataRows; // Count all sales rows, not just non-zero totals
    }
  } catch (e) {
    // fallback: use legacy record approach below
  }

  // Read purchase totals by finding the right column via headers
  var totalPurchases = 0;
  var purchasesCount = 0;
  try {
    var purchaseCols = getColumnIndicesByHeaders_(purchasesSheet);
    var purchaseTotalCol = purchaseCols["TotalCost"];
    var purchasesDataRows = Math.max(0, purchasesSheet.getLastRow() - 1);
    if (purchaseTotalCol !== undefined && purchasesDataRows > 0) {
      var purchasesData = purchasesSheet
        .getRange(2, purchaseTotalCol + 1, purchasesDataRows, 1)
        .getValues();
      for (var p = 0; p < purchasesData.length; p++) {
        var pVal = toNumber_(purchasesData[p] && purchasesData[p][0]);
        totalPurchases += pVal;
      }
      purchasesCount = purchasesDataRows; // Count all purchase rows, not just non-zero totals
    }
  } catch (e) {
    // fallback below
  }

  // Count low stock items quickly
  var lowStockCount = 0;
  try {
    var lowStockItems = getLowStockItemsFromItemsSheet_(itemsSheet);
    lowStockCount = lowStockItems.length;
  } catch (e) {
    lowStockCount = 0;
  }

  return {
    totalItems: totalItems,
    totalSales: totalSales,
    totalPurchases: totalPurchases,
    lowStockItems: lowStockCount,
    salesCount: salesCount,
    purchasesCount: purchasesCount,
  };
}

/* ================================================================
   Helper: get zero-indexed column map from sheet headers
   ================================================================ */
function getColumnIndicesByHeaders_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var raw = normalizeText_(headers[i]);
    // Store by exact trimmed name
    map[raw] = i;
    // Store by camelCase variant (remove spaces, capitalize next letter)
    var camelCase = raw.replace(/\s+(.)/g, function (match, chr) {
      return chr.toUpperCase();
    });
    if (camelCase !== raw) {
      map[camelCase] = i;
    }
    // Store by lowercase-no-spaces for fuzzy matching
    var flat = raw.replace(/\s+/g, "").toLowerCase();
    map[flat] = i;
  }
  return map;
}

/* ================================================================
   PERFORMANCE: Optimized low stock detection using stock map
   ================================================================ */
function getLowStockItemsFromItemsSheet_(itemsSheet) {
  var headers = getItemsHeaders_();
  var data = itemsSheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headerRow = data[0].map(function (h) {
    return normalizeText_(h);
  });
  var nameIdx = headerRow.indexOf("Name");
  var catIdx = headerRow.indexOf("Category");
  var minStockIdx = headerRow.indexOf("MinimumStock");
  var unitIdx = headerRow.indexOf("Unit");
  var idIdx = headerRow.indexOf("ID");

  if (idIdx === -1 || minStockIdx === -1) return [];

  var stockMap = buildItemStockMap_();
  var lowItems = [];

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var itemId = normalizeText_(row[idIdx]);
    var minStock = toNumber_(row[minStockIdx]);
    var currentStock = stockMap[itemId] || 0;

    if (minStock > 0 && currentStock <= minStock) {
      lowItems.push({
        itemId: itemId,
        name: nameIdx >= 0 ? normalizeText_(row[nameIdx]) : itemId,
        category: catIdx >= 0 ? normalizeText_(row[catIdx]) : "",
        unit: unitIdx >= 0 ? normalizeText_(row[unitIdx]) : "",
        currentStock: currentStock,
        minimumStock: minStock,
        shortage: Math.max(minStock - currentStock, 0),
      });
    }
  }

  lowItems.sort(function (a, b) {
    return b.shortage - a.shortage;
  });
  return lowItems;
}

/* ================================================================
   PERFORMANCE: Fast recent sales - reads last 10 rows only
   Uses dynamic column indices from headers
   ================================================================ */
function getRecentSalesFast_(salesSheet) {
  var lastRow = salesSheet.getLastRow();
  if (lastRow < 2) return [];

  var colMap = getColumnIndicesByHeaders_(salesSheet);
  var numCols = salesSheet.getLastColumn();

  // Read last 10 rows
  var startRow = Math.max(2, lastRow - 9);
  var numRows = lastRow - startRow + 1;
  var data = salesSheet.getRange(startRow, 1, numRows, numCols).getValues();

  var result = [];
  for (var r = data.length - 1; r >= 0; r--) {
    var row = data[r];
    result.push({
      id: normalizeText_(
        row[colMap["InvoiceNumber"]] || row[colMap["ID"]] || "",
      ),
      date: normalizeText_(
        row[colMap["SaleDate"]] || row[colMap["CreatedAt"]] || "",
      ),
      partyName: normalizeText_(row[colMap["CustomerName"]] || "Walk-in"),
      totalAmount: toNumber_(row[colMap["TotalAmount"]]),
      status: normalizeText_(row[colMap["Status"]] || "Completed"),
    });
  }

  return result;
}

/* ================================================================
   PERFORMANCE: Fast recent purchases - reads last 10 rows only
   Uses dynamic column indices from headers
   ================================================================ */
function getRecentPurchasesFast_(purchasesSheet) {
  var lastRow = purchasesSheet.getLastRow();
  if (lastRow < 2) return [];

  var colMap = getColumnIndicesByHeaders_(purchasesSheet);
  var numCols = purchasesSheet.getLastColumn();

  var startRow = Math.max(2, lastRow - 9);
  var numRows = lastRow - startRow + 1;
  var data = purchasesSheet.getRange(startRow, 1, numRows, numCols).getValues();

  var result = [];
  for (var r = data.length - 1; r >= 0; r--) {
    var row = data[r];
    result.push({
      id: normalizeText_(row[colMap["ID"]] || ""),
      date: normalizeText_(
        row[colMap["PurchaseDate"]] || row[colMap["CreatedAt"]] || "",
      ),
      partyName: normalizeText_(row[colMap["Supplier"]] || "Unknown"),
      totalAmount: toNumber_(row[colMap["TotalCost"]]),
      status: "Completed",
    });
  }

  return result;
}

function getExpiringBatchesFast_(purchasesSheet, itemsSheet) {
  var headers = getPurchasesHeaders_();
  var data = purchasesSheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headerRow = data[0].map(function (h) {
    return normalizeText_(h);
  });
  var idIdx = headerRow.indexOf("ID");
  var itemIdIdx = headerRow.indexOf("ItemID");
  var remQtyIdx = headerRow.indexOf("RemainingQuantity");
  var expDateIdx = headerRow.indexOf("ExpiryDate");
  var batchIdx = headerRow.indexOf("BatchNumber");

  if (itemIdIdx === -1 || remQtyIdx === -1 || expDateIdx === -1) return [];

  // Build item name map
  var itemNames = {};
  try {
    var itemData = itemsSheet.getDataRange().getValues();
    var itemHeaders = itemData[0].map(function (h) {
      return normalizeText_(h);
    });
    var itemNameIdx = itemHeaders.indexOf("Name");
    var itemIdColIdx = itemHeaders.indexOf("ID");
    for (var ir = 1; ir < itemData.length; ir++) {
      if (itemIdColIdx >= 0 && itemNameIdx >= 0) {
        itemNames[normalizeText_(itemData[ir][itemIdColIdx])] = normalizeText_(
          itemData[ir][itemNameIdx],
        );
      }
    }
  } catch (e) {}

  var now = new Date().getTime();
  var threshold = now + 60 * 24 * 60 * 60 * 1000; // 60 days

  var result = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var remQty = toNumber_(row[remQtyIdx]);
    var expDate = row[expDateIdx];
    if (remQty <= 0 || !expDate) continue;

    var expTime = new Date(expDate).getTime();
    if (expTime <= threshold) {
      var itemId = normalizeText_(row[itemIdIdx]);
      var daysLeft = Math.ceil((expTime - now) / (1000 * 60 * 60 * 24));
      result.push({
        batchNumber:
          batchIdx >= 0
            ? normalizeText_(row[batchIdx])
            : idIdx >= 0
              ? normalizeText_(row[idIdx])
              : "",
        itemId: itemId,
        itemName: itemNames[itemId] || "Unknown",
        remainingQuantity: remQty,
        expiryDate: expDate,
        daysToExpiry: daysLeft,
      });
    }
  }

  result.sort(function (a, b) {
    return a.daysToExpiry - b.daysToExpiry;
  });
  return result;
}

// Legacy functions kept for backward compatibility
function buildDashboardKpis_(items, sales, purchases, lowStockItems) {
  var totalSales = sales.reduce(function (t, s) {
    return t + toNumber_(s.totalAmount || s.totalPrice);
  }, 0);
  var totalPurchases = purchases.reduce(function (t, p) {
    return t + toNumber_(p.totalCost);
  }, 0);
  return {
    totalItems: items.length,
    totalSales: totalSales,
    totalPurchases: totalPurchases,
    lowStockItems: lowStockItems.length,
  };
}

function getLowStockItems_(items) {
  return items
    .map(function (item) {
      var currentStock = toNumber_(item.currentStock);
      var minimumStock = toNumber_(item.minimumStock);
      return {
        itemId: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit || "",
        currentStock: currentStock,
        minimumStock: minimumStock,
        shortage: Math.max(minimumStock - currentStock, 0),
      };
    })
    .filter(function (item) {
      return item.minimumStock > 0 && item.currentStock <= item.minimumStock;
    })
    .sort(function (a, b) {
      return b.shortage - a.shortage;
    });
}

function getRecentSales_(sales) {
  return sales
    .map(function (sale) {
      return {
        id: sale.invoiceNumber || sale.id,
        date: sale.saleDate || sale.createdAt || "",
        partyName: sale.customerName || "Walk-in",
        totalAmount: toNumber_(sale.totalPrice),
        status: sale.status || "Completed",
      };
    })
    .sort(function (a, b) {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
}

function getRecentPurchases_(purchases) {
  return purchases
    .map(function (purchase) {
      return {
        id: purchase.id,
        date: purchase.purchaseDate || purchase.createdAt || "",
        partyName: purchase.supplier || "Unknown",
        totalAmount: toNumber_(purchase.totalCost),
        status: "Completed",
      };
    })
    .sort(function (a, b) {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
}

function buildChartSummary_(sales, purchases) {
  return {
    salesCount: sales.length,
    purchasesCount: purchases.length,
    salesTotal: sales.reduce(function (t, s) {
      return t + toNumber_(s.totalPrice);
    }, 0),
    purchasesTotal: purchases.reduce(function (t, p) {
      return t + toNumber_(p.totalCost);
    }, 0),
  };
}
