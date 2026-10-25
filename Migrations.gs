// One-time data migration utilities for the Pharmacy System.

/**
 * Creates an initial purchase batch for every item that currently has stock.
 * This enables FIFO deduction using the Purchases remainingQuantity column.
 *
 * IMPORTANT: Run once only.
 */
function migrateCreateInitialBatches() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    // Automatically clear any previous corrupted initial stock batches (shifted columns)
    clearCorruptedInitialBatches();

    var items = getItemRecords_();
    var purchasesSheet = getPurchasesSheet_();
    var purchasesHeaders = getPurchasesHeaders_();

    // Ensure Purchases sheet exists (and headers are correct)
    // (getPurchasesSheet_ / getPurchasesHeaders_ are in Purchases.gs)

    var today = new Date();
    var expiry = new Date(today);
    expiry.setFullYear(expiry.getFullYear() + 1);

    var createdCount = 0;
    var skippedCount = 0;

    // Build a lookup of existing initial batches to make this idempotent.
    var existingPurchases = getPurchaseRecords_();
    var existingBatchKeys = {};
    existingPurchases.forEach(function (p) {
      if (p.batchNumber && p.batchNumber.indexOf("INITIAL-") === 0) {
        existingBatchKeys[p.itemId + "|" + p.batchNumber] = true;
      }
    });

    items.forEach(function (item) {
      var itemId = item.id;
      var currentStock = toNumber_(item.currentStock);

      if (currentStock <= 0) {
        skippedCount += 1;
        return;
      }

      var initialBatchNumber = "INITIAL-" + itemId;
      var key = itemId + "|" + initialBatchNumber;

      if (existingBatchKeys[key]) {
        skippedCount += 1;
        return;
      }

      var totalCost = toNumber_(item.costPrice) * currentStock;

      // Append a new row matching Purchases.gs schema
      purchasesSheet.appendRow([
        createPurchaseId_(), // ID
        itemId, // ItemID
        toNumber_(currentStock), // Quantity
        toNumber_(item.costPrice), // UnitPrice
        toNumber_(item.costPrice), // CostPrice
        toNumber_(item.sellingPrice), // SellingPrice
        toNumber_(totalCost), // TotalCost
        "Initial Stock", // Supplier
        formatSheetDate_(today), // PurchaseDate
        "Initial batch created by migration.", // Notes
        initialBatchNumber, // BatchNumber
        formatSheetDate_(expiry), // ExpiryDate
        toNumber_(currentStock), // RemainingQuantity
        Session.getEffectiveUser().getEmail() || "System", // CreatedBy
        formatDateTime_(today), // CreatedAt
        formatDateTime_(today), // UpdatedAt
      ]);

      createdCount += 1;
    });

    return successResponse_({
      created: createdCount,
      skipped: skippedCount,
      message: "Initial batches migration completed.",
    });
  } catch (error) {
    return errorResponse_(error.message || "Migration failed.");
  } finally {
    lock.releaseLock();
  }
}

// -------- Helpers (thin wrappers around functions defined in other .gs files) --------
// The following functions/values are expected to exist in the current Apps Script project:
// - getItemRecords_()
// - getPurchasesSheet_()
// - getPurchasesHeaders_()
// - getPurchaseRecords_()
// - createPurchaseId_()
// - formatDate_(), formatDateTime_()
// - toNumber_()
// - successResponse_(), errorResponse_()

function clearCorruptedInitialBatches() {
  var sheet = getPurchasesSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var values = sheet.getDataRange().getValues();
  var deletedCount = 0;

  // Loop backwards to safely delete rows without changing indices of remaining rows
  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    // Check if column 8 (index 7) has the note and column 9 (index 8) has the batch ID
    var isCorrupted =
      normalizeText_(row[7]) === "Initial batch created by migration." &&
      normalizeText_(row[8]).indexOf("INITIAL-") === 0;

    if (isCorrupted) {
      sheet.deleteRow(r + 1);
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidatePurchaseLookupMapCache_();
  }

  return deletedCount;
}
