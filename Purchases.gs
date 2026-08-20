function getPurchasesPageMeta(token) {
  assertAdminRole_(token);
  return successResponse_({
    sheetName: "Purchases",
    module: "Purchases",
    headers: getPurchasesHeaders_(),
    items: getItemRecords_(),
    suppliers: getPurchaseSuppliers_(),
  });
}

/* ================================================================
   PERFORMANCE: Lightweight suppliers list for dropdowns
   ================================================================ */
function getSuppliersList(token) {
  assertAdminRole_(token);
  var purchases = getPurchaseRecords_();
  var suppliers = [];
  for (var i = 0; i < purchases.length; i++) {
    var s = normalizeText_(purchases[i].supplier);
    if (s && suppliers.indexOf(s) === -1) {
      suppliers.push(s);
    }
  }
  suppliers = suppliers.concat([
    "Generic Supplier",
    "Pharma Distributor",
    "Local Vendor",
  ]);
  return successResponse_({ suppliers: suppliers });
}

function getPurchases(token) {
  assertAdminRole_(token);
  return successResponse_(buildPurchasesPayload_());
}

function buildPurchasesPayload_() {
  return {
    purchases: getPurchaseRecords_(),
    items: getItemRecords_(),
    suppliers: getPurchaseSuppliers_(),
  };
}

function createPurchase(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var purchase = validatePurchasePayload_(payload, "");
    var sheet = getPurchasesSheet_();
    var headers = getPurchasesHeaders_();
    var now = formatDateTime_(new Date());
    var purchaseId = createPurchaseId_();

    // Single source of truth for inventory: batch RemainingQuantity.
    // Do NOT update Items.currentStock here.

    // Write by header->column mapping to prevent column-shift bugs.
    var remainingQuantity = toNumber_(purchase.quantity);
    var rowValues = buildPurchasesRowValues_(
      {
        id: purchaseId,
        itemId: purchase.itemId,
        quantity: purchase.quantity,
        unitPrice: purchase.unitPrice,
        costPrice: purchase.costPrice,
        sellingPrice: purchase.sellingPrice,
        totalCost: purchase.totalCost,
        supplier: purchase.supplier,
        purchaseDate: purchase.purchaseDate,
        notes: purchase.notes,
        batchNumber: purchase.batchNumber,
        expiryDate: purchase.expiryDate,
        createdBy: purchase.createdBy,
        createdAt: now,
        updatedAt: now,
      },
      sheet,
      headers,
      remainingQuantity,
    );

    var targetRow = Math.max(2, sheet.getLastRow() + 1);
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidatePurchaseLookupMapCache_();
    invalidateItemLookupMapCache_();

    return successResponse_(buildPurchasesPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function updatePurchase(id, payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var purchaseId = normalizeText_(id);
    var existing = findPurchaseById_(purchaseId);
    var purchase = validatePurchasePayload_(payload, purchaseId);
    var now = formatDateTime_(new Date());

    if (!existing) {
      throw new Error("Purchase was not found.");
    }

    var oldQuantity = toNumber_(existing.quantity);
    var delta = toNumber_(purchase.quantity) - oldQuantity;

    // Single source of truth: RemainingQuantity in Purchases.
    // Update remaining based on quantity change.
    var newRemainingQuantity = Math.max(
      0,
      toNumber_(existing.remainingQuantity) + delta,
    );

    var sheet = getPurchasesSheet_();
    var headers = getPurchasesHeaders_();

    var rowValues = buildPurchasesRowValues_(
      {
        id: purchaseId,
        itemId: purchase.itemId,
        quantity: purchase.quantity,
        unitPrice: purchase.unitPrice,
        costPrice: purchase.costPrice,
        sellingPrice: purchase.sellingPrice,
        totalCost: purchase.totalCost,
        supplier: purchase.supplier,
        purchaseDate: purchase.purchaseDate,
        notes: purchase.notes,
        batchNumber: purchase.batchNumber,
        expiryDate: purchase.expiryDate,
        createdBy: existing.createdBy || purchase.createdBy,
        createdAt: existing.createdAt || now,
        updatedAt: now,
      },
      sheet,
      headers,
      newRemainingQuantity,
    );

    sheet
      .getRange(existing._rowNumber, 1, 1, rowValues.length)
      .setValues([rowValues]);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidatePurchaseLookupMapCache_();
    invalidateItemLookupMapCache_();

    return successResponse_(buildPurchasesPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function deletePurchase(id, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var purchaseId = normalizeText_(id);
    var existing = findPurchaseById_(purchaseId);

    if (!existing) {
      throw new Error("Purchase was not found.");
    }

    // Guard: block deletion if any sale allocation references this batch
    var allocations = getSheetRecords_("SalesAllocations", [
      "ID",
      "SaleID",
      "ItemID",
      "PurchaseID",
      "BatchRowNumber",
      "ConsumedQuantity",
      "CreatedAt",
      "UpdatedAt",
    ]);
    var hasAllocation = allocations.some(function (a) {
      return normalizeText_(a.PurchaseID) === purchaseId;
    });
    if (hasAllocation) {
      throw new Error(
        "Cannot delete this purchase batch — it has been used in one or more sales. " +
          "Delete the associated sales first.",
      );
    }

    // Delete batch record: inventory is derived from remainingQuantity.
    var sheet = getPurchasesSheet_();
    sheet.deleteRow(existing._rowNumber);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidatePurchaseLookupMapCache_();
    invalidateItemLookupMapCache_();

    return successResponse_(buildPurchasesPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function getPurchasesHeaders_() {
  return [
    "ID",
    "ItemID",
    "Quantity",
    "UnitPrice",
    "CostPrice",
    "SellingPrice",
    "TotalCost",
    "Supplier",
    "PurchaseDate",
    "Notes",
    "BatchNumber",
    "ExpiryDate",
    "RemainingQuantity",
    "CreatedBy",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getPurchasesSheet_() {
  // NOTE: avoid destructive header repairs on every read/write.
  // Header reconciliation is now performed at write-time when we build the
  // header->column index map.
  return getOrCreateSheet_("Purchases", getPurchasesHeaders_());
}

function getPurchasesColumnIndexMap_(sheet, headers, depth_) {
  if ((depth_ || 0) > 1) {
    throw new Error(
      "Purchases sheet headers could not be repaired. Please run repairInventoryHeaders() manually.",
    );
  }

  var headerRow = sheet
    .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length))
    .getValues()[0];
  var normalizedCurrent = headerRow.map(normalizeText_);

  // Build map from header name -> 1-based column index in the sheet.
  var map = {};
  normalizedCurrent.forEach(function (name, idx) {
    if (name) {
      map[name] = idx + 1;
    }
  });

  // Validate required headers exist.
  var missing = [];
  headers.forEach(function (h) {
    if (!map[h]) missing.push(h);
  });

  if (missing.length) {
    // Attempt repair once, then rebuild the map.
    repairInventoryHeaders();
    return getPurchasesColumnIndexMap_(sheet, headers, (depth_ || 0) + 1);
  }

  return map;
}

function buildPurchasesRowValues_(purchase, sheet, headers, remainingQuantity) {
  // Returns a rowValues array aligned to the actual sheet columns.
  // Values are placed by header name -> column index to prevent
  // column-shift bugs.
  var colIndex = getPurchasesColumnIndexMap_(sheet, headers);

  // Determine width to write: last column among required headers.
  var maxCol = 1;
  headers.forEach(function (h) {
    if (colIndex[h] && colIndex[h] > maxCol) maxCol = colIndex[h];
  });

  var rowValues = new Array(maxCol).fill("");

  // Required headers (defensive: map guarantees presence).
  rowValues[colIndex["ID"] - 1] = purchase.id;
  rowValues[colIndex["ItemID"] - 1] = purchase.itemId;
  rowValues[colIndex["Quantity"] - 1] = toNumber_(purchase.quantity);
  rowValues[colIndex["UnitPrice"] - 1] = toNumber_(purchase.unitPrice);
  rowValues[colIndex["CostPrice"] - 1] = toNumber_(purchase.costPrice);
  rowValues[colIndex["SellingPrice"] - 1] = toNumber_(purchase.sellingPrice);
  rowValues[colIndex["TotalCost"] - 1] = toNumber_(purchase.totalCost);
  rowValues[colIndex["Supplier"] - 1] = purchase.supplier;
  rowValues[colIndex["PurchaseDate"] - 1] = purchase.purchaseDate;
  rowValues[colIndex["Notes"] - 1] = purchase.notes;
  rowValues[colIndex["BatchNumber"] - 1] = purchase.batchNumber;
  rowValues[colIndex["ExpiryDate"] - 1] = purchase.expiryDate;
  rowValues[colIndex["RemainingQuantity"] - 1] = toNumber_(remainingQuantity);
  rowValues[colIndex["CreatedBy"] - 1] = purchase.createdBy;
  rowValues[colIndex["CreatedAt"] - 1] = purchase.createdAt;
  rowValues[colIndex["UpdatedAt"] - 1] = purchase.updatedAt;

  return rowValues;
}

/* ================================================================
   PERFORMANCE: Single-pass purchase lookup map
   ================================================================ */
var purchaseLookupMapCache_ = null;

function buildPurchaseLookupMap_() {
  if (purchaseLookupMapCache_ !== null) {
    return purchaseLookupMapCache_;
  }

  var purchases = getPurchaseRecords_();
  var map = {};

  for (var i = 0; i < purchases.length; i++) {
    map[purchases[i].id] = purchases[i];
  }

  purchaseLookupMapCache_ = map;
  return map;
}

function invalidatePurchaseLookupMapCache_() {
  purchaseLookupMapCache_ = null;
}

function getPurchaseRecords_() {
  return getCachedRecords_(
    "purchaseRecords",
    "Purchases",
    getPurchasesHeaders_(),
  ).map(function (record) {
    return {
      id: normalizeText_(record.ID),
      itemId: normalizeText_(record.ItemID),
      quantity: toNumber_(record.Quantity),
      unitPrice: toNumber_(record.UnitPrice),
      costPrice: toNumber_(record.CostPrice),
      sellingPrice: toNumber_(record.SellingPrice),
      totalCost: toNumber_(record.TotalCost),
      supplier: normalizeText_(record.Supplier),
      purchaseDate: formatSheetDate_(record.PurchaseDate),
      notes: normalizeText_(record.Notes),
      batchNumber: normalizeText_(record.BatchNumber),
      expiryDate: formatSheetDate_(record.ExpiryDate),
      remainingQuantity: toNumber_(record.RemainingQuantity),
      createdBy: normalizeText_(record.CreatedBy),
      createdAt: normalizeText_(record.CreatedAt),
      updatedAt: normalizeText_(record.UpdatedAt),
      _rowNumber: record._rowNumber,
    };
  });
}

/* ================================================================
   PERFORMANCE: O(1) purchase lookup using hash map
   ================================================================ */
function findPurchaseById_(id) {
  var purchaseId = normalizeText_(id);
  var map = buildPurchaseLookupMap_();
  return map[purchaseId] || null;
}

function createPurchaseId_() {
  return "PUR-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

function createBatchNumber_() {
  // Example format: BATCH-6charRandom
  return (
    "BATCH-" + Utilities.getUuid().replace(/-/g, "").slice(0, 6).toUpperCase()
  );
}

function validatePurchasePayload_(payload, existingId) {
  var data = payload || {};
  var purchase = {
    itemId: normalizeText_(data.itemId),
    quantity: toNumber_(data.quantity),
    unitPrice: toNumber_(data.unitPrice),
    costPrice: toNumber_(data.costPrice),
    sellingPrice: toNumber_(data.sellingPrice),
    totalCost: toNumber_(data.totalCost),
    supplier: normalizeText_(data.supplier),
    purchaseDate: normalizeText_(data.purchaseDate),
    notes: normalizeText_(data.notes),
    batchNumber: normalizeText_(data.batchNumber),
    expiryDate: normalizeText_(data.expiryDate),
    createdBy: normalizeText_(
      data.createdBy || Session.getEffectiveUser().getEmail() || "System",
    ),
  };

  // Auto-create Batch Number when user doesn't provide one.
  if (!purchase.batchNumber) {
    purchase.batchNumber = createBatchNumber_();
  }

  // Hardening (source of truth):
  // TotalCost must ALWAYS be quantity * unitPrice.
  // Never trust incoming totalCost from the client for sheet writes.
  var quantityLooksValid =
    Number.isFinite(purchase.quantity) && purchase.quantity >= 0;
  var unitPriceLooksValid =
    Number.isFinite(purchase.unitPrice) && purchase.unitPrice >= 0;

  if (quantityLooksValid && unitPriceLooksValid) {
    purchase.totalCost = purchase.quantity * purchase.unitPrice;
  } else {
    purchase.totalCost = 0;
  }

  if (!purchase.itemId) {
    throw new Error("Select an item before saving the purchase.");
  }

  if (!findItemById_(purchase.itemId)) {
    throw new Error("The selected item was not found.");
  }

  if (purchase.quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

  if (purchase.unitPrice < 0) {
    throw new Error("Unit price cannot be negative.");
  }

  if (purchase.costPrice < 0) {
    throw new Error("Cost price cannot be negative.");
  }

  if (purchase.sellingPrice < 0) {
    throw new Error("Selling price cannot be negative.");
  }

  if (purchase.totalCost < 0) {
    throw new Error("Total cost cannot be negative.");
  }

  if (!purchase.supplier) {
    throw new Error("Supplier is required.");
  }

  if (!purchase.purchaseDate) {
    throw new Error("Purchase date is required.");
  }

  return purchase;
}

function getPurchaseSuppliers_() {
  var purchases = getPurchaseRecords_();
  var suppliers = [];

  purchases.forEach(function (purchase) {
    if (purchase.supplier && suppliers.indexOf(purchase.supplier) === -1) {
      suppliers.push(purchase.supplier);
    }
  });

  return suppliers.concat([
    "Generic Supplier",
    "Pharma Distributor",
    "Local Vendor",
  ]);
}


