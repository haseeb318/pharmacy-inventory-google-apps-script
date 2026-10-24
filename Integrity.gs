/**
 * ===================================================================
 * Database Constraints & Data Integrity Guardrails (Phase 2 - Issue #1)
 * ===================================================================
 * 
 * Provides:
 * 1. Native Google Sheets Data Validation rules (reject invalid edits in UI).
 * 2. Header row protections (prevent renaming/moving column headers).
 * 3. Diagnostic integrity checks (orphaned rows, negative stock, broken sales).
 * 4. Automatic repair utilities.
 */

/**
 * Applies native Google Sheets Data Validation rules to key columns
 * across all tables. Invalid inputs are rejected directly in the UI.
 *
 * Can be run by admins at any time.
 */
function setupDatabaseValidations() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. Sales Sheet Validations
    var salesSheet = getSalesSheet_();
    if (salesSheet) {
      var salesHeaders = getSalesHeaders_();
      var salesMaxRows = Math.max(salesSheet.getMaxRows() - 1, 100);

      // Status: Completed, Pending, Cancelled, _BROKEN_
      var statusCol = salesHeaders.indexOf("Status") + 1;
      if (statusCol > 0) {
        var statusRule = SpreadsheetApp.newDataValidation()
          .requireValueInList(["Completed", "Pending", "Cancelled", "_BROKEN_"], true)
          .setAllowInvalid(false)
          .setHelpText("Status must be Completed, Pending, Cancelled, or _BROKEN_.")
          .build();
        salesSheet.getRange(2, statusCol, salesMaxRows, 1).setDataValidation(statusRule);
      }

      // PaymentMethod: Cash, Card, UPI, Bank Transfer, Credit, Cheque
      var payMethodCol = salesHeaders.indexOf("PaymentMethod") + 1;
      if (payMethodCol > 0) {
        var payRule = SpreadsheetApp.newDataValidation()
          .requireValueInList(["Cash", "Card", "UPI", "Bank Transfer", "Credit", "Cheque"], true)
          .setAllowInvalid(false)
          .setHelpText("Select a valid payment method from the list.")
          .build();
        salesSheet.getRange(2, payMethodCol, salesMaxRows, 1).setDataValidation(payRule);
      }

      // TotalAmount: Number >= 0
      var totalCol = salesHeaders.indexOf("TotalAmount") + 1;
      if (totalCol > 0) {
        var totalRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .setHelpText("Total Amount must be a positive number or zero.")
          .build();
        salesSheet.getRange(2, totalCol, salesMaxRows, 1).setDataValidation(totalRule);
      }
    }

    // 2. Sale_Items Sheet Validations
    var itemsSheet = getSaleItemsSheet_();
    if (itemsSheet) {
      var itemHeaders = getSaleItemsHeaders_();
      var itemsMaxRows = Math.max(itemsSheet.getMaxRows() - 1, 100);

      // Quantity: Number > 0
      var qtyCol = itemHeaders.indexOf("Quantity") + 1;
      if (qtyCol > 0) {
        var qtyRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThan(0)
          .setAllowInvalid(false)
          .setHelpText("Quantity must be greater than zero.")
          .build();
        itemsSheet.getRange(2, qtyCol, itemsMaxRows, 1).setDataValidation(qtyRule);
      }

      // UnitPrice: Number >= 0
      var priceCol = itemHeaders.indexOf("UnitPrice") + 1;
      if (priceCol > 0) {
        var priceRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .setHelpText("Unit price cannot be negative.")
          .build();
        itemsSheet.getRange(2, priceCol, itemsMaxRows, 1).setDataValidation(priceRule);
      }

      // TotalPrice: Number >= 0
      var lineTotalCol = itemHeaders.indexOf("TotalPrice") + 1;
      if (lineTotalCol > 0) {
        var lineTotalRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .setHelpText("Total price cannot be negative.")
          .build();
        itemsSheet.getRange(2, lineTotalCol, itemsMaxRows, 1).setDataValidation(lineTotalRule);
      }
    }

    // 3. Purchases Sheet Validations
    var purchaseSheet = getPurchasesSheet_();
    if (purchaseSheet) {
      var purchaseHeaders = getPurchasesHeaders_();
      var purchaseMaxRows = Math.max(purchaseSheet.getMaxRows() - 1, 100);

      // Quantity: Number > 0
      var pQtyCol = purchaseHeaders.indexOf("Quantity") + 1;
      if (pQtyCol > 0) {
        var pQtyRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThan(0)
          .setAllowInvalid(false)
          .setHelpText("Purchase quantity must be greater than zero.")
          .build();
        purchaseSheet.getRange(2, pQtyCol, purchaseMaxRows, 1).setDataValidation(pQtyRule);
      }

      // RemainingQuantity: Number >= 0 (PREVENTS NEGATIVE STOCK DIRECTLY IN SHEET UI)
      var remQtyCol = purchaseHeaders.indexOf("RemainingQuantity") + 1;
      if (remQtyCol > 0) {
        var remRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .setHelpText("Remaining quantity cannot be negative.")
          .build();
        purchaseSheet.getRange(2, remQtyCol, purchaseMaxRows, 1).setDataValidation(remRule);
      }

      // CostPrice & SellingPrice: Number >= 0
      var costCol = purchaseHeaders.indexOf("CostPrice") + 1;
      if (costCol > 0) {
        var numRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .setHelpText("Price must be a positive number or zero.")
          .build();
        purchaseSheet.getRange(2, costCol, purchaseMaxRows, 1).setDataValidation(numRule);
      }
    }

    // 4. SalesAllocations Sheet Validations
    var allocSheet = getSalesAllocationsSheet_();
    if (allocSheet) {
      var allocHeaders = getSalesAllocationsHeaders_();
      var allocMaxRows = Math.max(allocSheet.getMaxRows() - 1, 100);

      var consumedCol = allocHeaders.indexOf("ConsumedQuantity") + 1;
      if (consumedCol > 0) {
        var consumedRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThan(0)
          .setAllowInvalid(false)
          .setHelpText("Consumed quantity must be greater than zero.")
          .build();
        allocSheet.getRange(2, consumedCol, allocMaxRows, 1).setDataValidation(consumedRule);
      }
    }

    // 5. Items Sheet Validations
    var itemsMasterSheet = getItemsSheet_();
    if (itemsMasterSheet) {
      var itemMasterHeaders = getItemsHeaders_();
      var masterMaxRows = Math.max(itemsMasterSheet.getMaxRows() - 1, 100);

      var itemStatusCol = itemMasterHeaders.indexOf("Status") + 1;
      if (itemStatusCol > 0) {
        var itemStatusRule = SpreadsheetApp.newDataValidation()
          .requireValueInList(["Active", "Inactive", "Discontinued"], true)
          .setAllowInvalid(false)
          .setHelpText("Item status must be Active, Inactive, or Discontinued.")
          .build();
        itemsMasterSheet.getRange(2, itemStatusCol, masterMaxRows, 1).setDataValidation(itemStatusRule);
      }

      var minStockCol = itemMasterHeaders.indexOf("MinimumStock") + 1;
      if (minStockCol > 0) {
        var minStockRule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .setHelpText("Minimum stock must be 0 or higher.")
          .build();
        itemsMasterSheet.getRange(2, minStockCol, masterMaxRows, 1).setDataValidation(minStockRule);
      }
    }

    return successResponse_({
      applied: true,
      message: "Data validation rules successfully configured across Sales, Sale_Items, Purchases, Items, and SalesAllocations.",
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Protects row 1 (headers) across all system sheets with a warning
 * or edit restriction to prevent users from accidentally renaming columns.
 */
function protectDatabaseHeaders() {
  var sheetNames = ["Sales", "Sale_Items", "Purchases", "SalesAllocations", "Items", "Users", "Customers", "Suppliers"];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var protectedSheets = [];

  sheetNames.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;

    var headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1));
    var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    var exists = false;

    for (var i = 0; i < protections.length; i++) {
      if (protections[i].getDescription() === "System Header Row Protection") {
        exists = true;
        break;
      }
    }

    if (!exists) {
      var protection = headerRange.protect();
      protection.setDescription("System Header Row Protection");
      protection.setWarningOnly(true); // Warning alert when someone attempts to edit header
      protectedSheets.push(name);
    }
  });

  return successResponse_({
    protectedSheets: protectedSheets,
    message: "Header row protections configured.",
  });
}

/**
 * Diagnostic Tool: Comprehensive database integrity scan.
 * Checks for orphaned records, negative stock, broken sales, and financial drift.
 *
 * @returns {Object} Diagnostic report with error lists and counts.
 */
function checkDatabaseIntegrity() {
  var sales = getSalesRecords_();
  var saleItems = getSaleItemsRecords_();
  var purchases = getPurchaseRecords_();
  var allocations = getSalesAllocationsRecords_();
  var items = getItemRecords_();

  var saleIdSet = {};
  sales.forEach(function (s) { saleIdSet[s.id] = true; });

  var purchaseIdSet = {};
  purchases.forEach(function (p) { purchaseIdSet[p.id] = true; });

  var itemIdSet = {};
  items.forEach(function (it) { itemIdSet[it.id] = true; });

  var report = {
    healthy: true,
    summary: {
      totalSales: sales.length,
      totalSaleItems: saleItems.length,
      totalPurchases: purchases.length,
      totalAllocations: allocations.length,
      totalItems: items.length,
    },
    issues: {
      negativeStockPurchases: [],
      orphanedSaleItems: [],
      orphanedAllocations: [],
      brokenSales: [],
      financialMismatches: [],
    },
  };

  // 1. Check for negative stock batches
  purchases.forEach(function (p) {
    var rem = toNumber_(p.remainingQuantity);
    if (rem < 0) {
      report.issues.negativeStockPurchases.push({
        purchaseId: p.id,
        itemId: p.itemId,
        remainingQuantity: rem,
        rowNumber: p._rowNumber,
      });
      report.healthy = false;
    }
  });

  // 2. Check for orphaned sale items (SaleID not in Sales)
  saleItems.forEach(function (si) {
    if (!saleIdSet[si.saleId]) {
      report.issues.orphanedSaleItems.push({
        saleItemId: si.id,
        saleId: si.saleId,
        rowNumber: si._rowNumber,
      });
      report.healthy = false;
    }
  });

  // 3. Check for orphaned allocations (SaleID not in Sales or PurchaseID not in Purchases)
  allocations.forEach(function (a) {
    var missingSale = !saleIdSet[a.saleId];
    var missingPurchase = a.purchaseId && !purchaseIdSet[a.purchaseId];
    if (missingSale || missingPurchase) {
      report.issues.orphanedAllocations.push({
        allocationId: a.id,
        saleId: a.saleId,
        purchaseId: a.purchaseId,
        missingSale: missingSale,
        missingPurchase: missingPurchase,
        rowNumber: a._rowNumber,
      });
      report.healthy = false;
    }
  });

  // 4. Check for broken sales
  sales.forEach(function (s) {
    if (s.status === "_BROKEN_") {
      report.issues.brokenSales.push({
        saleId: s.id,
        invoiceNumber: s.invoiceNumber,
        rowNumber: s._rowNumber,
      });
      report.healthy = false;
    }
  });

  // 5. Check financial totals alignment
  var itemTotalsBySale = {};
  saleItems.forEach(function (it) {
    if (!itemTotalsBySale[it.saleId]) itemTotalsBySale[it.saleId] = 0;
    itemTotalsBySale[it.saleId] += toNumber_(it.totalPrice);
  });

  sales.forEach(function (s) {
    var headerTotal = Math.round(toNumber_(s.totalAmount) * 100) / 100;
    var lineTotal = Math.round(toNumber_(itemTotalsBySale[s.id] || 0) * 100) / 100;
    if (Math.abs(headerTotal - lineTotal) > 0.01) {
      report.issues.financialMismatches.push({
        saleId: s.id,
        invoiceNumber: s.invoiceNumber,
        headerTotal: headerTotal,
        lineTotal: lineTotal,
        difference: Math.round((headerTotal - lineTotal) * 100) / 100,
      });
      report.healthy = false;
    }
  });

  return successResponse_(report);
}

/**
 * Automatic Repair Tool: Safely fixes orphaned allocations and re-syncs financial totals.
 */
function repairDatabaseIntegrity() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var check = checkDatabaseIntegrity();
    if (!check.success) return check;

    var issues = check.data.issues;
    var repairs = {
      orphanedAllocationsRemoved: 0,
      financialTotalsSynced: 0,
    };

    // 1. Remove orphaned allocations where saleId no longer exists
    if (issues.orphanedAllocations.length > 0) {
      var orphanedSaleIds = {};
      issues.orphanedAllocations.forEach(function (a) {
        if (a.missingSale) orphanedSaleIds[a.saleId] = true;
      });

      for (var sId in orphanedSaleIds) {
        if (orphanedSaleIds.hasOwnProperty(sId)) {
          deleteAllocationsBySaleId_(sId);
          repairs.orphanedAllocationsRemoved++;
        }
      }
    }

    // 2. Re-sync financial mismatches
    if (issues.financialMismatches.length > 0) {
      var recon = reconcileSalesTotals(true);
      if (recon.success) {
        repairs.financialTotalsSynced = recon.data.fixed || 0;
      }
    }

    invalidateAllCaches_();

    return successResponse_({
      repairs: repairs,
      message: "Database integrity repair complete.",
    });
  } finally {
    lock.releaseLock();
  }
}
