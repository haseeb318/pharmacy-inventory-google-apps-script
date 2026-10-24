function getSalesPageMeta(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  return successResponse_({
    sheetName: "Sales",
    module: "Sales",
    headers: getSalesHeaders_(),
    items: getItemRecords_(),
    customers: getSalesCustomers_(),
  });
}

/* ================================================================
   PERFORMANCE: Lightweight customers list for dropdowns
   ================================================================ */
function getCustomersList(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  return successResponse_({ customers: getSalesCustomers_() });
}

function buildItemSellingPriceMap_() {
  var purchases = getPurchaseRecords_();
  var todayStr = formatSheetDate_(new Date());

  // Sort by expiryDate ascending, fallback to purchaseDate ascending (oldest non-expired first - FEFO/FIFO)
  purchases.sort(function (a, b) {
    var dateA = a.expiryDate || a.purchaseDate || "9999-12-31";
    var dateB = b.expiryDate || b.purchaseDate || "9999-12-31";
    return dateA.localeCompare(dateB);
  });

  var priceMap = {};
  purchases.forEach(function (p) {
    var isExpired = p.expiryDate && p.expiryDate < todayStr;
    // Pick the oldest active batch with remaining stock that is NOT expired
    if (!priceMap[p.itemId] && p.remainingQuantity > 0 && !isExpired) {
      priceMap[p.itemId] = p.sellingPrice;
    }
  });

  // Fallback: if an item has no active non-expired batch, use Item master selling price
  var items = getItemRecords_();
  items.forEach(function (it) {
    if (priceMap[it.id] === undefined && it.sellingPrice != null) {
      priceMap[it.id] = it.sellingPrice;
    }
  });

  return priceMap;
}

function getSales(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  return successResponse_(buildSalesPayload_());
}

function buildSalesPayload_() {
  return {
    sales: getSalesRecords_(),
    items: getItemRecords_(),
    customers: getSalesCustomers_(),
    itemSellingPrices: buildItemSellingPriceMap_(),
  };
}

/**
 * Create a multi-item sale with batch FIFO allocation.
 * payload.items: [{itemId, quantity, unitPrice, totalPrice}]
 */
function createSale(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  // Fix #1: Declare outside try so the catch block can reference them for rollback
  var saleId = null;
  var saleSheet = null;
  var saleHeaderWritten = false;

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    // Fix #4: Force live read — bypass 15-second stale cache before validation
    invalidateDataCache_();
    invalidatePurchasesByItemMapCache_();
    // PERFORMANCE: Single group-by pass over purchases to avoid per-item full table scans
    var purchasesByItem = buildPurchasesByItemMap_();
    var sale = validateSalePayload_(payload, "", purchasesByItem);
    saleSheet = getSalesSheet_();
    var itemsSheet = getSaleItemsSheet_();
    var now = formatDateTime_(new Date());
    saleId = createSaleId_();
    var invoiceNumber = normalizeText_(
      sale.invoiceNumber ||
        "INV-" + Utilities.getUuid().split("-")[0].toUpperCase(),
    );

    // Write sale header
    var totalAmount = 0;
    var items = sale.items || [];
    for (var i = 0; i < items.length; i++) {
      totalAmount += toNumber_(items[i].totalPrice);
    }
    totalAmount = Math.round(totalAmount * 100) / 100;

    saleSheet.appendRow([
      saleId,
      invoiceNumber,
      sale.customerName,
      sale.customerPhone,
      sale.saleDate,
      sale.paymentMethod,
      sale.status,
      sale.notes,
      toNumber_(totalAmount),
      sale.createdBy,
      now,
      now,
    ]);
    saleHeaderWritten = true; // Fix #1: flag so rollback knows the header row exists

    // Write sale items and allocate batches per item
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var saleItemId = createSaleItemId_();
      var normalizedItemId = normalizeText_(item.itemId);

      itemsSheet.appendRow([
        saleItemId,
        saleId,
        item.itemId,
        toNumber_(item.quantity),
        toNumber_(item.unitPrice),
        toNumber_(item.totalPrice),
        now,
        now,
      ]);

      // Allocate FIFO batches using pre-grouped purchases
      // Fix #2: capture return so we can update the in-memory snapshot
      var allocated = allocateSaleBatches_(
        saleId,
        item.itemId,
        toNumber_(item.quantity),
        purchasesByItem[normalizedItemId] || [],
      );
      // Fix #2: mutate snapshot so the next item sees the correct remainingQuantity
      updatePurchasesByItemSnapshot_(purchasesByItem, allocated);
    }

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidateSaleLookupMapCache_();
    invalidateItemLookupMapCache_();
    invalidatePurchaseLookupMapCache_();
    invalidatePurchasesByItemMapCache_();

    // PERFORMANCE: Return minimal delta instead of full page payload
    return successResponse_({
      action: "create",
      sale: {
        id: saleId,
        invoiceNumber: invoiceNumber,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        saleDate: sale.saleDate,
        paymentMethod: sale.paymentMethod,
        status: sale.status,
        notes: sale.notes,
        totalAmount: toNumber_(totalAmount),
        itemCount: items.length,
        items: items.map(function (it) {
          return {
            itemId: it.itemId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            totalPrice: it.totalPrice,
          };
        }),
        createdBy: sale.createdBy,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    // Fix #1: Best-effort compensating rollback — undo any partial writes
    rollbackCreateSale_(saleId, saleSheet, saleHeaderWritten);
    invalidateDataCache_();
    invalidatePurchasesByItemMapCache_();
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Update a multi-item sale.
 * Restores all allocations, deletes old items, writes new header + items, re-allocates.
 */
function updateSale(id, payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  // Fix #1: Declare outside try so the catch block can reference it for rollback
  var saleId = null;

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    saleId = normalizeText_(id);
    var existing = findSaleById_(saleId);
    // Fix #4: Force live read — bypass 15-second stale cache before validation
    invalidateDataCache_();
    invalidatePurchasesByItemMapCache_();
    // PERFORMANCE: Single group-by pass over purchases
    var purchasesByItem = buildPurchasesByItemMap_();
    var sale = validateSalePayload_(payload, saleId, purchasesByItem);
    var now = formatDateTime_(new Date());

    if (!existing) {
      throw new Error("Sale was not found.");
    }

    // Restore exactly what was allocated for this sale (all items)
    restoreSaleAllocations_(saleId);

    // Delete old sale items
    deleteSaleItemsBySaleId_(saleId);

    // PERFORMANCE: Rebuild purchasesByItem map with FRESH data after allocation restore
    // (restoreSaleAllocations_ modified purchase remaining quantities)
    purchasesByItem = buildPurchasesByItemMap_();

    // Update sale header
    var totalAmount = 0;
    var items = sale.items || [];
    for (var i = 0; i < items.length; i++) {
      totalAmount += toNumber_(items[i].totalPrice);
    }
    totalAmount = Math.round(totalAmount * 100) / 100;

    var saleSheet = getSalesSheet_();
    var headers = getSalesHeaders_();
    var rowValues = [];
    for (var h = 0; h < headers.length; h++) {
      var header = headers[h];
      if (header === "ID") rowValues.push(saleId);
      else if (header === "InvoiceNumber") rowValues.push(sale.invoiceNumber);
      else if (header === "CustomerName") rowValues.push(sale.customerName);
      else if (header === "CustomerPhone") rowValues.push(sale.customerPhone);
      else if (header === "SaleDate") rowValues.push(sale.saleDate);
      else if (header === "PaymentMethod") rowValues.push(sale.paymentMethod);
      else if (header === "Status") rowValues.push(sale.status);
      else if (header === "Notes") rowValues.push(sale.notes);
      else if (header === "TotalAmount") rowValues.push(toNumber_(totalAmount));
      else if (header === "CreatedBy")
        rowValues.push(existing.createdBy || sale.createdBy);
      else if (header === "CreatedAt")
        rowValues.push(existing.createdAt || now);
      else if (header === "UpdatedAt") rowValues.push(now);
      else rowValues.push("");
    }

    saleSheet
      .getRange(existing._rowNumber, 1, 1, rowValues.length)
      .setValues([rowValues]);

    // Write new sale items and allocate batches
    var itemsSheet = getSaleItemsSheet_();
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var saleItemId = createSaleItemId_();
      var normalizedItemId = normalizeText_(item.itemId);

      itemsSheet.appendRow([
        saleItemId,
        saleId,
        item.itemId,
        toNumber_(item.quantity),
        toNumber_(item.unitPrice),
        toNumber_(item.totalPrice),
        now,
        now,
      ]);

      // Allocate FIFO batches using pre-grouped purchases
      // Fix #2: capture return so we can update the in-memory snapshot
      var allocated = allocateSaleBatches_(
        saleId,
        item.itemId,
        toNumber_(item.quantity),
        purchasesByItem[normalizedItemId] || [],
      );
      // Fix #2: mutate snapshot so the next item sees the correct remainingQuantity
      updatePurchasesByItemSnapshot_(purchasesByItem, allocated);
    }

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidateSaleLookupMapCache_();
    invalidateItemLookupMapCache_();
    invalidatePurchaseLookupMapCache_();
    invalidatePurchasesByItemMapCache_();

    // PERFORMANCE: Return minimal delta instead of full page payload
    return successResponse_({
      action: "update",
      sale: {
        id: saleId,
        invoiceNumber: sale.invoiceNumber,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        saleDate: sale.saleDate,
        paymentMethod: sale.paymentMethod,
        status: sale.status,
        notes: sale.notes,
        totalAmount: toNumber_(totalAmount),
        itemCount: items.length,
        items: items.map(function (it) {
          return {
            itemId: it.itemId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            totalPrice: it.totalPrice,
          };
        }),
        createdBy: existing.createdBy || sale.createdBy,
        createdAt: existing.createdAt || now,
        updatedAt: now,
      },
    });
  } catch (error) {
    // Fix #1: Best-effort compensating rollback for partial new allocations
    rollbackUpdateSale_(saleId, getSalesSheet_());
    invalidateDataCache_();
    invalidatePurchasesByItemMapCache_();
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Delete a sale: restore allocations, delete sale items, delete sale header.
 */
function deleteSale(id, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var saleId = normalizeText_(id);
    var existing = findSaleById_(saleId);

    if (!existing) {
      throw new Error("Sale was not found.");
    }

    var deletedItems = findSaleItemsBySaleId_(saleId);

    // Restore exactly what was allocated for this sale
    // (restoreSaleAllocations_ already cleans the SalesAllocations rows — no need for a second pass)
    restoreSaleAllocations_(saleId);

    // Delete sale items
    deleteSaleItemsBySaleId_(saleId);

    // Delete sale header
    var saleSheet = getSalesSheet_();
    saleSheet.deleteRow(existing._rowNumber);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidateSaleLookupMapCache_();
    invalidateItemLookupMapCache_();
    invalidatePurchaseLookupMapCache_();
    invalidatePurchasesByItemMapCache_();

    // PERFORMANCE: Return minimal delta instead of full page payload
    return successResponse_({
      action: "delete",
      saleId: saleId,
      items: (deletedItems || []).map(function (it) {
        return {
          itemId: it.itemId,
          quantity: it.quantity,
        };
      }),
    });
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

/* ================================================================
   Sale Items (line items) functions
   ================================================================ */

function getSaleItemsHeaders_() {
  return [
    "ID",
    "SaleID",
    "ItemID",
    "Quantity",
    "UnitPrice",
    "TotalPrice",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getSaleItemsSheet_() {
  return getOrCreateSheet_("Sale_Items", getSaleItemsHeaders_());
}

function getSaleItemsRecords_(saleId) {
  var allItems = getCachedRecords_(
    "saleItemsRecords",
    "Sale_Items",
    getSaleItemsHeaders_(),
  );

  // Always map raw records to normalized objects with lowercase property names
  var mappedItems = allItems.map(function (r) {
    return {
      id: normalizeText_(r.ID),
      saleId: normalizeText_(r.SaleID),
      itemId: normalizeText_(r.ItemID),
      quantity: toNumber_(r.Quantity),
      unitPrice: toNumber_(r.UnitPrice),
      totalPrice: toNumber_(r.TotalPrice),
      createdAt: normalizeText_(r.CreatedAt),
      updatedAt: normalizeText_(r.UpdatedAt),
      _rowNumber: r._rowNumber,
    };
  });

  if (!saleId) return mappedItems;

  var normalizedSaleId = normalizeText_(saleId);
  return mappedItems.filter(function (r) {
    return r.saleId === normalizedSaleId;
  });
}

function deleteSaleItemsBySaleId_(saleId) {
  var normalizedSaleId = normalizeText_(saleId);
  var sheet = getSaleItemsSheet_();
  var headers = getSaleItemsHeaders_();

  // Find SaleID column index from headers array
  var saleIdColIndex = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h] === "SaleID") {
      saleIdColIndex = h;
      break;
    }
  }
  if (saleIdColIndex === -1) return;

  var dataRange = sheet.getDataRange();
  var allRows = dataRange.getValues();

  if (allRows.length < 2) return; // only header row

  // PERFORMANCE: Read-filter-rewrite instead of N individual deleteRow calls
  var keepRows = [allRows[0]]; // always keep header
  for (var i = 1; i < allRows.length; i++) {
    if (normalizeText_(allRows[i][saleIdColIndex]) !== normalizedSaleId) {
      keepRows.push(allRows[i]);
    }
  }

  if (keepRows.length === allRows.length) return; // nothing to delete

  // Fix #7: Clear ONLY data rows (row 2 onwards), keeping Row 1 headers, formatting & validations intact
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  }
  if (keepRows.length > 1) {
    var dataToSet = keepRows.slice(1);
    sheet.getRange(2, 1, dataToSet.length, dataToSet[0].length).setValues(dataToSet);
  }
}

function createSaleItemId_() {
  return "SLI-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

/* ================================================================
   Sales Header functions
   ================================================================ */

function getSalesHeaders_() {
  return [
    "ID",
    "InvoiceNumber",
    "CustomerName",
    "CustomerPhone",
    "SaleDate",
    "PaymentMethod",
    "Status",
    "Notes",
    "TotalAmount",
    "CreatedBy",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getSalesSheet_() {
  return getOrCreateSheet_("Sales", getSalesHeaders_());
}

/* ================================================================
   PERFORMANCE: Single-pass sale lookup map
   ================================================================ */
var saleLookupMapCache_ = null;

function buildSaleLookupMap_() {
  if (saleLookupMapCache_ !== null) {
    return saleLookupMapCache_;
  }

  var sales = getSalesRecords_();
  var map = {};

  for (var i = 0; i < sales.length; i++) {
    map[sales[i].id] = sales[i];
  }

  saleLookupMapCache_ = map;
  return map;
}

function invalidateSaleLookupMapCache_() {
  saleLookupMapCache_ = null;
}

/* ================================================================
   PERFORMANCE: Build sale items map in single pass
   Groups sale items by saleId for O(1) lookup per sale
   ================================================================ */
function buildSaleItemsMap_() {
  var allItems = getSaleItemsRecords_(null);
  var map = {};

  for (var i = 0; i < allItems.length; i++) {
    var item = allItems[i];
    if (!map[item.saleId]) {
      map[item.saleId] = [];
    }
    map[item.saleId].push(item);
  }

  return map;
}

function getSalesRecords_() {
  var rawRecords = getCachedRecords_(
    "salesRecords",
    "Sales",
    getSalesHeaders_(),
  );
  // Build sale items map ONCE instead of filtering per sale
  var saleItemsMap = buildSaleItemsMap_();

  return rawRecords.map(function (record) {
    var saleId = normalizeText_(record.ID);
    var saleItems = saleItemsMap[saleId] || [];

    var totalAmount = 0;
    for (var i = 0; i < saleItems.length; i++) {
      totalAmount += saleItems[i].totalPrice;
    }

    return {
      id: saleId,
      invoiceNumber: normalizeText_(record.InvoiceNumber),
      customerName: normalizeText_(record.CustomerName),
      customerPhone: normalizeText_(record.CustomerPhone),
      saleDate: formatSheetDate_(record.SaleDate),
      paymentMethod: normalizeText_(record.PaymentMethod),
      status: normalizeText_(record.Status),
      notes: normalizeText_(record.Notes),
      totalAmount: totalAmount,
      itemCount: saleItems.length,
      items: saleItems,
      createdBy: normalizeText_(record.CreatedBy),
      createdAt: normalizeText_(record.CreatedAt),
      updatedAt: normalizeText_(record.UpdatedAt),
      _rowNumber: record._rowNumber,
    };
  });
}

/* ================================================================
   PERFORMANCE: O(1) sale lookup using hash map
   ================================================================ */
function findSaleById_(id) {
  var saleId = normalizeText_(id);
  var map = buildSaleLookupMap_();
  return map[saleId] || null;
}

function findSaleItemsBySaleId_(saleId) {
  return getSaleItemsRecords_(saleId);
}

function createSaleId_() {
  return "SAL-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

/* ================================================================
   Validation
   ================================================================ */

function validateSalePayload_(payload, existingId, purchasesByItem) {
  var data = payload || {};
  var items = data.items || [];

  // At least one item required
  if (!items.length) {
    throw new Error("At least one item is required for a sale.");
  }

  var sale = {
    invoiceNumber: normalizeText_(data.invoiceNumber || ""),
    customerName: normalizeText_(data.customerName || ""),
    customerPhone: normalizeText_(data.customerPhone || ""),
    saleDate: normalizeText_(data.saleDate || ""),
    paymentMethod: normalizeText_(data.paymentMethod || "Cash"),
    status: normalizeText_(data.status || "Completed"),
    notes: normalizeText_(data.notes || ""),
    createdBy: normalizeText_(
      data.createdBy || Session.getEffectiveUser().getEmail() || "System",
    ),
    items: [],
  };

  if (!sale.customerName) {
    throw new Error("Customer name is required.");
  }

  if (!sale.saleDate) {
    throw new Error("Sale date is required.");
  }

  // Validate each item and check stock availability
  var itemStockMap = {};

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var itemId = normalizeText_(item.itemId || "");
    var quantity = toNumber_(item.quantity);
    var unitPrice = toNumber_(item.unitPrice);

    if (!itemId) {
      throw new Error("Item selection is required for all line items.");
    }

    if (!findItemById_(itemId)) {
      throw new Error("Item '" + itemId + "' was not found.");
    }

    if (quantity <= 0) {
      throw new Error("Quantity must be greater than zero for all items.");
    }

    if (unitPrice < 0) {
      throw new Error("Unit price cannot be negative.");
    }

    var totalPrice = Math.round(quantity * unitPrice * 100) / 100;
    if (totalPrice < 0) {
      throw new Error("Total price cannot be negative.");
    }

    // Accumulate required quantities per item to check total availability
    if (!itemStockMap[itemId]) {
      itemStockMap[itemId] = 0;
    }
    itemStockMap[itemId] += quantity;

    sale.items.push({
      itemId: itemId,
      quantity: quantity,
      unitPrice: unitPrice,
      totalPrice: totalPrice,
    });
  }

  // Check batch availability for each unique item (exclude current sale's existing allocations on update)
  var existingItems = [];
  if (existingId) {
    existingItems = getSaleItemsRecords_(existingId);
  }

  for (var itemKey in itemStockMap) {
    if (itemStockMap.hasOwnProperty(itemKey)) {
      var requiredQty = itemStockMap[itemKey];

      // On update, exclude what was already allocated for this sale
      var existingQty = 0;
      if (existingId) {
        for (var e = 0; e < existingItems.length; e++) {
          if (existingItems[e].itemId === itemKey) {
            existingQty += existingItems[e].quantity;
          }
        }
      }

      var netRequired = requiredQty - existingQty;
      if (netRequired <= 0) continue;

      // PERFORMANCE: Use pre-grouped purchases map to avoid per-item full table scan
      var purchases;
      if (purchasesByItem) {
        var itemBatches = purchasesByItem[itemKey] || [];
        purchases = itemBatches.filter(function (p) {
          return toNumber_(p.remainingQuantity) > 0;
        });
      } else {
        purchases = getPurchaseRecords_().filter(function (p) {
          return (
            normalizeText_(p.itemId) === itemKey &&
            toNumber_(p.remainingQuantity) > 0
          );
        });
      }

      var availableStock = purchases.reduce(function (t, p) {
        return t + toNumber_(p.remainingQuantity);
      }, 0);

      if (toNumber_(availableStock) < netRequired) {
        var itemName = (findItemById_(itemKey) || {}).name || itemKey;
        throw new Error(
          "Insufficient stock for '" +
            itemName +
            "'. Available: " +
            toNumber_(availableStock) +
            ", Required: " +
            netRequired,
        );
      }
    }
  }

  return sale;
}

function getSalesCustomers_() {
  var masterCustomers = getCustomerRecords_();
  var seen = {};
  var customers = [];

  masterCustomers.forEach(function (c) {
    var name = normalizeText_(c.name);
    if (name && !seen[name.toLowerCase()]) {
      seen[name.toLowerCase()] = true;
      customers.push(name);
    }
  });

  if (customers.length === 0) {
    var sales = getSalesRecords_();
    sales.forEach(function (sale) {
      var name = normalizeText_(sale.customerName);
      if (name && !seen[name.toLowerCase()]) {
        seen[name.toLowerCase()] = true;
        customers.push(name);
      }
    });

    ["Walk-in Customer", "Retail Customer", "Wholesale Customer"].forEach(function (defName) {
      if (!seen[defName.toLowerCase()]) {
        seen[defName.toLowerCase()] = true;
        customers.push(defName);
      }
    });
  }

  return customers;
}

/* ================================================================
   Invoice / Printing
   ================================================================ */

/**
 * Server-callable: returns invoice data for a sale with pharmacy batch tracking.
 */
function getSaleInvoice(saleId, token) {
  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var sale = findSaleById_(saleId);
    if (!sale) {
      throw new Error("Sale was not found.");
    }

    var items = getSaleItemsRecords_(saleId);
    var itemMap = {};
    var allItems = getItemRecords_();
    for (var i = 0; i < allItems.length; i++) {
      itemMap[allItems[i].id] = allItems[i];
    }

    var allAllocations = getSalesAllocationsRecords_();
    var saleAllocations = allAllocations.filter(function (a) {
      return a.saleId === sale.id;
    });
    var purchaseMap = buildPurchaseLookupMap_();

    var invoiceItems = [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var itemRecord = itemMap[item.itemId] || {};

      // Retrieve batch & expiry details for dispensed medicine
      var itemAllocs = saleAllocations.filter(function (a) {
        return normalizeText_(a.itemId) === normalizeText_(item.itemId);
      });

      var batchDetails = [];
      itemAllocs.forEach(function (al) {
        var p = purchaseMap[al.purchaseId] || {};
        var bNum = p.batchNumber || al.purchaseId || "-";
        var expStr = p.expiryDate ? formatDisplayDate_(p.expiryDate) : "-";
        batchDetails.push({
          batchNumber: bNum,
          expiryDate: expStr,
          quantity: al.consumedQuantity,
        });
      });

      invoiceItems.push({
        name: itemRecord.name || item.itemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        batches: batchDetails,
      });
    }

    return successResponse_({
      invoiceNumber: sale.invoiceNumber,
      saleDate: formatDisplayDate_(sale.saleDate),
      customerName: sale.customerName,
      customerPhone: sale.customerPhone,
      items: invoiceItems,
      totalAmount: sale.totalAmount,
      generatedAt: formatDateTime_(new Date()),
    });
  } catch (error) {
    return errorResponse_(error.message || "Unable to load invoice.");
  }
}

/**
 * Server-callable: returns printable HTML for invoice.
 */
function printSaleInvoice(saleId, token) {
  try {
    var invoiceResponse = getSaleInvoice(saleId, token);
    if (!invoiceResponse.success) {
      throw new Error(invoiceResponse.message);
    }
    var invoice = invoiceResponse.data;
    var html = generateInvoiceHtml_(invoice);
    return successResponse_({ html: html });
  } catch (error) {
    return errorResponse_(error.message || "Unable to generate invoice.");
  }
}

function generateInvoiceHtml_(invoice) {
  if (!invoice) return "<p>No invoice data.</p>";

  var itemsHtml = "";
  for (var i = 0; i < invoice.items.length; i++) {
    var item = invoice.items[i];
    var batchText = "";
    if (item.batches && item.batches.length) {
      batchText = item.batches
        .map(function (b) {
          return (
            "Batch: " +
            escapeHtml_(b.batchNumber) +
            " (Exp: " +
            escapeHtml_(b.expiryDate) +
            ")"
          );
        })
        .join(", ");
    }

    itemsHtml +=
      "<tr>" +
      "<td>" +
      "<div><strong>" +
      escapeHtml_(item.name || "Unknown") +
      "</strong></div>" +
      (batchText
        ? "<div style='font-size:11px;color:#6b7280;margin-top:2px;'>" +
          batchText +
          "</div>"
        : "") +
      "</td>" +
      "<td style='text-align:center'>" +
      item.quantity +
      "</td>" +
      "<td style='text-align:right'>" +
      formatCurrency_(item.unitPrice) +
      "</td>" +
      "<td style='text-align:right'>" +
      formatCurrency_(item.totalPrice) +
      "</td>" +
      "</tr>";
  }

  return (
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ' +
    escapeHtml_(invoice.invoiceNumber || "") +
    "</title><style>" +
    "body{font-family:Arial,sans-serif;color:#111827;margin:40px;}" +
    ".invoice-header{border-bottom:2px solid #e5e7eb;padding-bottom:16px;margin-bottom:24px;}" +
    ".invoice-header h1{margin:0 0 4px;font-size:24px;}" +
    ".invoice-header .meta{color:#6b7280;font-size:13px;margin:2px 0;}" +
    ".customer-info{margin-bottom:24px;}" +
    ".customer-info p{margin:2px 0;font-size:14px;}" +
    "table{border-collapse:collapse;width:100%;font-size:14px;}" +
    "th,td{border:1px solid #d1d5db;padding:10px 12px;text-align:left;}" +
    "th{background:#f3f4f6;font-weight:600;}" +
    ".total-row td{font-weight:700;font-size:16px;}" +
    ".footer{margin-top:32px;padding-top:16px;border-top:1px solid #d1d5db;color:#6b7280;font-size:12px;text-align:center;}" +
    "@media print{body{margin:20px;}.no-print{display:none!important;}}" +
    "</style></head><body>" +
    "<div class='invoice-header'>" +
    "<h1>PHARMACY INVOICE</h1>" +
    "<p class='meta'>Invoice No: <strong>" +
    escapeHtml_(invoice.invoiceNumber || "-") +
    "</strong></p>" +
    "<p class='meta'>Date: " +
    escapeHtml_(invoice.saleDate || "-") +
    "</p>" +
    "<p class='meta'>Generated: " +
    escapeHtml_(invoice.generatedAt || "-") +
    "</p>" +
    "</div>" +
    "<div class='customer-info'>" +
    "<p><strong>Customer:</strong> " +
    escapeHtml_(invoice.customerName || "-") +
    "</p>" +
    "<p><strong>Phone:</strong> " +
    escapeHtml_(invoice.customerPhone || "-") +
    "</p>" +
    "</div>" +
    "<table>" +
    "<thead><tr><th>Item & Batch Details</th><th style='text-align:center'>Qty</th><th style='text-align:right'>Unit Price</th><th style='text-align:right'>Total</th></tr></thead>" +
    "<tbody>" +
    itemsHtml +
    "</tbody>" +
    "<tfoot>" +
    "<tr class='total-row'>" +
    "<td colspan='3' style='text-align:right'>Total Amount:</td>" +
    "<td style='text-align:right'>" +
    formatCurrency_(invoice.totalAmount) +
    "</td>" +
    "</tr>" +
    "</tfoot>" +
    "</table>" +
    "<div class='footer'>Thank you for your business! Please check medicines before leaving the counter.</div>" +
    "</body></html>"
  );
}

/* ================================================================
   FIFO / FEFO Allocation Engine
   ================================================================ */

function getSalesAllocationsSheet_() {
  return getOrCreateSheet_("SalesAllocations", [
    "ID",
    "SaleID",
    "ItemID",
    "PurchaseID",
    "BatchRowNumber",
    "ConsumedQuantity",
    "CreatedAt",
    "UpdatedAt",
  ]);
}

function allocateSaleBatches_(saleId, itemId, quantityToSell, itemPurchases) {
  var qty = toNumber_(quantityToSell);
  if (qty <= 0) return [];

  var todayStr = formatSheetDate_(new Date());

  var purchases;
  if (itemPurchases) {
    // Pre-grouped purchases passed in — avoid full table scan
    purchases = itemPurchases.filter(function (p) {
      var isExpired = p.expiryDate && p.expiryDate < todayStr;
      return toNumber_(p.remainingQuantity) > 0 && !isExpired;
    });
  } else {
    // Fallback: full scan
    purchases = getPurchaseRecords_().filter(function (p) {
      var isExpired = p.expiryDate && p.expiryDate < todayStr;
      return (
        normalizeText_(p.itemId) === normalizeText_(itemId) &&
        toNumber_(p.remainingQuantity) > 0 &&
        !isExpired
      );
    });
  }

  // Sort by nearest expiry date first (FEFO)
  purchases.sort(function (a, b) {
    var dateA = new Date(a.expiryDate || "9999-12-31").getTime();
    var dateB = new Date(b.expiryDate || "9999-12-31").getTime();
    return dateA - dateB;
  });

  var purchaseSheet = getPurchasesSheet_();
  var allocSheet = getSalesAllocationsSheet_();
  var now = formatDateTime_(new Date());

  var purchaseHeaders = getPurchasesHeaders_();
  var colMap = getPurchasesColumnIndexMap_(purchaseSheet, purchaseHeaders);
  var remainingCol = colMap["RemainingQuantity"] || 14;

  var pendingAllocations = [];
  var remainingUpdates = [];

  for (var i = 0; i < purchases.length; i++) {
    if (qty <= 0) break;

    var batch = purchases[i];
    var available = toNumber_(batch.remainingQuantity);
    if (available <= 0) continue;

    var consumed = Math.min(available, qty);
    if (consumed <= 0) continue;

    // Collect stock update for this batch row
    remainingUpdates.push({
      rowNumber: batch._rowNumber,
      newValue: available - consumed,
    });

    // Collect allocation record — no sheet write yet
    pendingAllocations.push({
      purchaseId: batch.id,
      batchRowNumber: batch._rowNumber,
      consumedQuantity: consumed,
    });

    qty -= consumed;
  }

  // Check sufficiency before touching any sheet (fail fast, zero side-effects)
  if (qty > 0) {
    throw new Error("Insufficient stock for this sale.");
  }

  // STEP 1 (Fix #3): Decrement purchase stock FIRST.
  // If the script dies after this point but before alloc records are written,
  // restoreSaleAllocations_ finds no rows and won't double-restore.
  // A slight undercount is safer than phantom excess stock.
  for (var u = 0; u < remainingUpdates.length; u++) {
    purchaseSheet
      .getRange(remainingUpdates[u].rowNumber, remainingCol, 1, 1)
      .setValue(remainingUpdates[u].newValue);
  }

  // STEP 2 (Fix #7): Batch-write all allocation records in ONE setValues call.
  var allocRows = [];
  var fullAllocations = [];
  for (var a = 0; a < pendingAllocations.length; a++) {
    var al = pendingAllocations[a];
    var allocId = "ALC-" + Utilities.getUuid().split("-")[0].toUpperCase();
    allocRows.push([
      allocId,
      saleId,
      itemId,
      al.purchaseId,
      al.batchRowNumber,
      al.consumedQuantity,
      now,
      now,
    ]);
    fullAllocations.push({
      id: allocId,
      saleId: saleId,
      itemId: itemId,
      purchaseId: al.purchaseId,
      batchRowNumber: al.batchRowNumber,
      consumedQuantity: al.consumedQuantity,
    });
  }

  if (allocRows.length > 0) {
    var allocStartRow = allocSheet.getLastRow() + 1;
    allocSheet
      .getRange(allocStartRow, 1, allocRows.length, allocRows[0].length)
      .setValues(allocRows);
  }

  return fullAllocations;
}

function restoreSaleAllocations_(saleId) {
  var normalizedSaleId = normalizeText_(saleId);

  // Use cached allocation records
  var allocs = getSalesAllocationsRecords_();
  var allocations = allocs.filter(function (a) {
    return a.saleId === normalizedSaleId;
  });

  if (!allocations.length) return;

  var purchaseSheet = getPurchasesSheet_();
  var purchaseHeaders = getPurchasesHeaders_();
  var colMap = getPurchasesColumnIndexMap_(purchaseSheet, purchaseHeaders);
  var idCol = colMap["ID"] || 1;
  var remainingCol = colMap["RemainingQuantity"] || 14;

  var lastPurchaseRow = purchaseSheet.getLastRow();
  var idToRowMap = {};

  // PERFORMANCE: Read ONLY the ID column in one single call.
  // Even with 50,000 rows, reading a 1-column range takes only ~15-30ms.
  if (lastPurchaseRow >= 2) {
    var idValues = purchaseSheet
      .getRange(2, idCol, lastPurchaseRow - 1, 1)
      .getValues();
    for (var r = 0; r < idValues.length; r++) {
      var pid = normalizeText_(idValues[r][0]);
      if (pid) {
        idToRowMap[pid] = r + 2; // actual current 1-based sheet row
      }
    }
  }

  // Group consumed quantities by PurchaseID (with rowNumber fallback for legacy records)
  var restoreByPurchase = {};
  allocations.forEach(function (a) {
    var pid = normalizeText_(a.purchaseId);
    var targetKey = pid ? "ID:" + pid : "ROW:" + a.batchRowNumber;
    if (!restoreByPurchase[targetKey]) {
      restoreByPurchase[targetKey] = {
        purchaseId: pid,
        fallbackRow: toNumber_(a.batchRowNumber),
        qty: 0,
      };
    }
    restoreByPurchase[targetKey].qty += toNumber_(a.consumedQuantity);
  });

  // Restore each affected batch row directly
  for (var key in restoreByPurchase) {
    if (restoreByPurchase.hasOwnProperty(key)) {
      var item = restoreByPurchase[key];
      var targetRow = null;

      // 1. Primary: Locate current live row using PurchaseID
      if (item.purchaseId && idToRowMap[item.purchaseId]) {
        targetRow = idToRowMap[item.purchaseId];
      }
      // 2. Fallback: Use batchRowNumber only if PurchaseID not found / legacy row
      else if (item.fallbackRow && item.fallbackRow >= 2 && item.fallbackRow <= lastPurchaseRow) {
        targetRow = item.fallbackRow;
      }

      if (targetRow) {
        var currentVal = toNumber_(
          purchaseSheet.getRange(targetRow, remainingCol, 1, 1).getValue(),
        );
        purchaseSheet
          .getRange(targetRow, remainingCol, 1, 1)
          .setValue(currentVal + item.qty);
      } else {
        Logger.log(
          "Warning: Could not locate purchase batch for restoration. ID: " +
            item.purchaseId +
            ", Fallback row: " +
            item.fallbackRow,
        );
      }
    }
  }

  // Delete allocation records by SaleID (immune to row-index shifting)
  deleteAllocationsBySaleId_(saleId);

  // Invalidate stock and related lookup caches
  invalidateDataCache_();
  invalidateStockMapCache_();
  invalidatePurchasesByItemMapCache_();
  invalidateSaleLookupMapCache_();
  invalidateItemLookupMapCache_();
}

/* ================================================================
   ACID Fix Helpers
   ================================================================ */

/**
 * Fix #2: After allocating batches for one sale item, update the in-memory
 * purchasesByItem snapshot so the NEXT item in the same sale sees the
 * correct remainingQuantity — preventing same-batch double-deduction.
 *
 * @param {Object} purchasesByItem  The live in-memory map (mutated in place).
 * @param {Array}  allocations      Return value from allocateSaleBatches_.
 */
function updatePurchasesByItemSnapshot_(purchasesByItem, allocations) {
  if (!purchasesByItem || !allocations || !allocations.length) return;
  allocations.forEach(function (al) {
    var itemBatches = purchasesByItem[normalizeText_(al.itemId)] || [];
    itemBatches.forEach(function (batch) {
      if (normalizeText_(batch.id) === normalizeText_(al.purchaseId)) {
        batch.remainingQuantity = Math.max(
          0,
          toNumber_(batch.remainingQuantity) - toNumber_(al.consumedQuantity),
        );
      }
    });
  });
}

/**
 * Fix #1: Best-effort compensating rollback for createSale.
 * Attempts to undo all partial writes in reverse order.
 * If rollback itself fails, stamps the sale row as _BROKEN_ so an admin
 * can find and manually correct it.
 *
 * @param {string|null}  saleId            The sale ID (may be null if failure was pre-ID).
 * @param {Sheet|null}   saleSheet         The Sales sheet reference.
 * @param {boolean}      saleHeaderWritten Whether the header row was committed.
 */
function rollbackCreateSale_(saleId, saleSheet, saleHeaderWritten) {
  if (!saleId) return; // failed before ID was assigned — nothing to roll back
  try {
    // Restore any stock already decremented, remove alloc + item rows
    restoreSaleAllocations_(saleId);
    deleteAllocationsBySaleId_(saleId);
    deleteSaleItemsBySaleId_(saleId);
    if (saleHeaderWritten && saleSheet) {
      invalidateSaleLookupMapCache_();
      var sale = findSaleById_(saleId);
      if (sale) {
        saleSheet.deleteRow(sale._rowNumber);
      }
    }
  } catch (rollbackErr) {
    // Rollback itself failed — mark row as _BROKEN_ for manual review
    try {
      invalidateSaleLookupMapCache_();
      var broken = findSaleById_(saleId);
      if (broken && saleSheet) {
        // Status is the 7th column in getSalesHeaders_()
        saleSheet.getRange(broken._rowNumber, 7, 1, 1).setValue("_BROKEN_");
      }
    } catch (e) { /* silent — best effort */ }
  }
}

/**
 * Fix #1: Best-effort compensating rollback for updateSale.
 * Because the old items are deleted before the new write loop begins,
 * a perfect undo is not possible. This function:
 *   1. Restores any NEW allocations already committed (stock returned).
 *   2. Stamps the sale as _BROKEN_ so an admin can review it.
 *
 * @param {string|null}  saleId     The sale ID.
 * @param {Sheet|null}   saleSheet  The Sales sheet reference.
 */
function rollbackUpdateSale_(saleId, saleSheet) {
  if (!saleId) return;
  try {
    restoreSaleAllocations_(saleId);
    deleteAllocationsBySaleId_(saleId);
  } catch (e) { /* silent */ }
  try {
    invalidateSaleLookupMapCache_();
    var broken = findSaleById_(saleId);
    if (broken && saleSheet) {
      // Status is the 7th column in getSalesHeaders_()
      saleSheet.getRange(broken._rowNumber, 7, 1, 1).setValue("_BROKEN_");
    }
  } catch (e) { /* silent */ }
}

/* ================================================================
   Financial Reconciliation Tool (Fix #6)
   ================================================================ */

/**
 * Reconciliation Tool: Scans all sales records and compares Sales.TotalAmount
 * with the authoritative sum of corresponding Sale_Items.TotalPrice.
 *
 * @param {boolean} [autoFix=false] If true, automatically synchronizes the Sales header with the line items sum.
 * @returns {Object} Report of verified, mismatched, and repaired records.
 */
function reconcileSalesTotals(autoFix) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var saleSheet = getSalesSheet_();
    var salesHeaders = getSalesHeaders_();
    var salesRecords = getSalesRecords_();
    var allItems = getSaleItemsRecords_();

    // Map saleId -> sum of item totals
    var itemTotalsBySale = {};
    for (var i = 0; i < allItems.length; i++) {
      var sId = normalizeText_(allItems[i].saleId);
      if (!itemTotalsBySale[sId]) {
        itemTotalsBySale[sId] = 0;
      }
      itemTotalsBySale[sId] += toNumber_(allItems[i].totalPrice);
    }

    var totalCol = -1;
    for (var h = 0; h < salesHeaders.length; h++) {
      if (salesHeaders[h] === "TotalAmount") {
        totalCol = h + 1;
        break;
      }
    }

    var report = {
      totalSalesChecked: salesRecords.length,
      matched: 0,
      mismatches: [],
      fixed: 0,
    };

    for (var s = 0; s < salesRecords.length; s++) {
      var sale = salesRecords[s];
      var storedHeaderTotal = Math.round(toNumber_(sale.totalAmount) * 100) / 100;
      var sId = normalizeText_(sale.id);
      var calculatedItemsTotal = Math.round(toNumber_(itemTotalsBySale[sId] || 0) * 100) / 100;

      if (Math.abs(storedHeaderTotal - calculatedItemsTotal) > 0.001) {
        report.mismatches.push({
          saleId: sale.id,
          invoiceNumber: sale.invoiceNumber,
          rowNumber: sale._rowNumber,
          storedTotal: storedHeaderTotal,
          calculatedTotal: calculatedItemsTotal,
          difference: Math.round((storedHeaderTotal - calculatedItemsTotal) * 100) / 100,
        });

        if (autoFix && totalCol > 0 && sale._rowNumber) {
          saleSheet.getRange(sale._rowNumber, totalCol, 1, 1).setValue(calculatedItemsTotal);
          report.fixed++;
        }
      } else {
        report.matched++;
      }
    }

    if (autoFix && report.fixed > 0) {
      invalidateDataCache_();
      invalidateSaleLookupMapCache_();
    }

    return successResponse_(report);
  } finally {
    lock.releaseLock();
  }
}
