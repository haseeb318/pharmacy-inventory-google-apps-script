function getInventoryPageMeta(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  return successResponse_({
    module: "Inventory",
    sheetName: "Inventory",
    expiryWarningDaysDefault: 30,
  });
}

// Returns batch records for a single medicine.
// Filter key can be either medicineId (ITM-...) or medicineName.
// Intended for lazy loading.
/* ================================================================
   PERFORMANCE: Batch expiry map built in single pass
   Groups purchases by itemId so each item gets O(1) lookup
   ================================================================ */
function buildNearestExpiryMap_(purchases) {
  // Group purchases by itemId, tracking earliest expiry per item
  var expiryByItem = {};

  for (var i = 0; i < purchases.length; i++) {
    var p = purchases[i];
    var itemId = normalizeText_(p.itemId);
    var remQty = toNumber_(p.remainingQuantity);
    var expDate = p.expiryDate;

    if (remQty <= 0 || !expDate) continue;

    if (!expiryByItem[itemId]) {
      expiryByItem[itemId] = [];
    }
    expiryByItem[itemId].push({
      expiryDate: expDate,
      rawTime: new Date(expDate).getTime(),
    });
  }

  // Sort each item's batches by expiry date, return nearest
  var nearestMap = {};
  var now = Date.now();

  for (var itemId in expiryByItem) {
    if (expiryByItem.hasOwnProperty(itemId)) {
      var batches = expiryByItem[itemId];
      // Find earliest expiry date
      var earliest = batches[0];
      for (var j = 1; j < batches.length; j++) {
        if (batches[j].rawTime < earliest.rawTime) {
          earliest = batches[j];
        }
      }

      var nearestExpiryDays = Math.ceil(
        (earliest.rawTime - now) / (1000 * 60 * 60 * 24),
      );
      var nearestExpiryStatus = "OK";
      if (nearestExpiryDays < 0) nearestExpiryStatus = "Expired";
      else if (nearestExpiryDays <= 30) nearestExpiryStatus = "Expiring";

      nearestMap[itemId] = {
        nearestExpiryDays: nearestExpiryDays,
        nearestExpiryDate: new Date(earliest.expiryDate)
          .toISOString()
          .split("T")[0],
        nearestExpiryStatus: nearestExpiryStatus,
      };
    }
  }

  return nearestMap;
}

/* ================================================================
   PERFORMANCE: Optimized getMedicineBatches using hash map lookup + 
   pre-filtered purchase group
   ================================================================ */
function getMedicineBatches(medicineId, token) {
  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var key = normalizeText_(medicineId);
    if (!key) {
      return successResponse_({ batches: [] });
    }

    // Use hash map for O(1) item lookup
    var itemMap = buildItemLookupMap_();
    var medicine = itemMap[key];

    if (!medicine) {
      // Try name match (normalized) - iterate once
      var items = getItemRecords_();
      for (var j = 0; j < items.length; j += 1) {
        if (normalizeText_(items[j].name) === key) {
          medicine = items[j];
          break;
        }
      }
    }

    if (!medicine) {
      return successResponse_({ batches: [] });
    }

    // Use cached purchases
    var purchases = getPurchaseRecords_();
    var medId = normalizeText_(medicine.id);

    // Single pass filter + map
    var batches = [];
    for (var i = 0; i < purchases.length; i++) {
      var p = purchases[i];
      if (normalizeText_(p.itemId) !== medId) continue;
      if (toNumber_(p.remainingQuantity) <= 0) continue;

      batches.push({
        batchNumber: p.batchNumber || "-",
        remainingQuantity: toNumber_(p.remainingQuantity),
        expiryDate: p.expiryDate || "",
        costPrice: toNumber_(p.costPrice || 0),
        sellingPrice: toNumber_(p.sellingPrice || 0),
      });
    }

    batches.sort(function (a, b) {
      var da = a.expiryDate ? new Date(a.expiryDate).getTime() : 9999999999999;
      var db = b.expiryDate ? new Date(b.expiryDate).getTime() : 9999999999999;
      return da - db;
    });

    return successResponse_({ batches: batches });
  } catch (error) {
    return errorResponse_(error.message || "Unable to load medicine batches.");
  }
}

/* ================================================================
   PERFORMANCE: Optimized getInventory
   - Builds nearest expiry map ONCE in single pass (O(n))
   - Uses stock map for O(1) currentStock per item
   - Avoids O(n²) nested filter loops
   ================================================================ */
function getInventory(token) {
  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var items = getItemRecords_();
    var purchases = getPurchaseRecords_();

    // Single-pass expiry map: O(n) instead of O(n×m)
    var nearestExpiryMap = buildNearestExpiryMap_(purchases);

    // Use stock map for O(1) currentStock per item
    var stockMap = buildItemStockMap_();
    var now = Date.now();

    var summaryRows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var itemId = it.id;
      var currentStock = stockMap[itemId] || 0;
      var minimumStock = toNumber_(it.minimumStock || 0);
      var expiry = nearestExpiryMap[itemId] || null;

      summaryRows.push({
        itemId: itemId,
        name: it.name,
        category: it.category,
        currentStock: currentStock,
        minimumStock: minimumStock,
        nearestExpiryDays: expiry ? expiry.nearestExpiryDays : null,
        nearestExpiryDate: expiry ? expiry.nearestExpiryDate : "-",
        nearestExpiryStatus: expiry ? expiry.nearestExpiryStatus : "OK",
      });
    }

    // Sort: low stock first, then nearest expiry
    summaryRows.sort(function (a, b) {
      var aLow = a.currentStock <= a.minimumStock ? 0 : 1;
      var bLow = b.currentStock <= b.minimumStock ? 0 : 1;
      if (aLow !== bLow) return aLow - bLow;

      var aDays =
        typeof a.nearestExpiryDays === "number" ? a.nearestExpiryDays : 999999;
      var bDays =
        typeof b.nearestExpiryDays === "number" ? b.nearestExpiryDays : 999999;
      return aDays - bDays;
    });

    return successResponse_({
      expiryWarningDays: 30,
      summary: summaryRows,
    });
  } catch (error) {
    return errorResponse_(error.message || "Unable to load inventory.");
  }
}
