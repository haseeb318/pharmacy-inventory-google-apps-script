function getSalesPageMeta() {
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
function getCustomersList() {
  var sales = getSalesRecords_();
  var customers = [];
  for (var i = 0; i < sales.length; i++) {
    var c = normalizeText_(sales[i].customerName);
    if (c && customers.indexOf(c) === -1) {
      customers.push(c);
    }
  }
  customers = customers.concat([
    "Walk-in Customer",
    "Retail Customer",
    "Wholesale Customer",
  ]);
  return successResponse_({ customers: customers });
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

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var sale = validateSalePayload_(payload, "");
    var saleSheet = getSalesSheet_();
    var itemsSheet = getSaleItemsSheet_();
    var now = formatDateTime_(new Date());
    var saleId = createSaleId_();
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

    // Write sale items and allocate batches per item
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var saleItemId = createSaleItemId_();

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

      // Allocate FIFO batches for this item
      allocateSaleBatches_(saleId, item.itemId, toNumber_(item.quantity));
    }

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidateSaleLookupMapCache_();
    invalidateItemLookupMapCache_();
    invalidatePurchaseLookupMapCache_();

    return successResponse_(buildSalesPayload_());
  } catch (error) {
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

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var saleId = normalizeText_(id);
    var existing = findSaleById_(saleId);
    var sale = validateSalePayload_(payload, saleId);
    var now = formatDateTime_(new Date());

    if (!existing) {
      throw new Error("Sale was not found.");
    }

    // Restore exactly what was allocated for this sale (all items)
    restoreSaleAllocations_(saleId);

    // Delete old sale items
    deleteSaleItemsBySaleId_(saleId);

    // Update sale header
    var totalAmount = 0;
    var items = sale.items || [];
    for (var i = 0; i < items.length; i++) {
      totalAmount += toNumber_(items[i].totalPrice);
    }

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

      allocateSaleBatches_(saleId, item.itemId, toNumber_(item.quantity));
    }

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateStockMapCache_();
    invalidateSaleLookupMapCache_();
    invalidateItemLookupMapCache_();
    invalidatePurchaseLookupMapCache_();

    return successResponse_(buildSalesPayload_());
  } catch (error) {
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

    // Restore exactly what was allocated for this sale
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

    return successResponse_(buildSalesPayload_());
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
  var allItems = getSheetRecords_("Sale_Items", getSaleItemsHeaders_());

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
  var allItems = getSheetRecords_("Sale_Items", getSaleItemsHeaders_());
  var itemsToDelete = allItems.filter(function (r) {
    return normalizeText_(r.SaleID) === normalizedSaleId;
  });

  if (!itemsToDelete.length) return;

  var sheet = getSaleItemsSheet_();
  // Delete in reverse order to preserve row numbers
  for (var i = itemsToDelete.length - 1; i >= 0; i--) {
    sheet.deleteRow(itemsToDelete[i]._rowNumber);
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

function createSaleId_() {
  return "SAL-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

/* ================================================================
   Validation
   ================================================================ */

function validateSalePayload_(payload, existingId) {
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

    var totalPrice = quantity * unitPrice;
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

      var purchases = getPurchaseRecords_().filter(function (p) {
        return (
          normalizeText_(p.itemId) === itemKey &&
          toNumber_(p.remainingQuantity) > 0
        );
      });

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
  var sales = getSalesRecords_();
  var customers = [];

  sales.forEach(function (sale) {
    if (sale.customerName && customers.indexOf(sale.customerName) === -1) {
      customers.push(sale.customerName);
    }
  });

  return customers.concat([
    "Walk-in Customer",
    "Retail Customer",
    "Wholesale Customer",
  ]);
}

/* ================================================================
   Invoice / Printing
   ================================================================ */

/**
 * Server-callable: returns invoice data for a sale.
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

    var invoiceItems = [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var itemRecord = itemMap[item.itemId] || {};
      invoiceItems.push({
        name: itemRecord.name || item.itemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      });
    }

    return successResponse_({
      invoiceNumber: sale.invoiceNumber,
      saleDate: sale.saleDate,
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
    itemsHtml +=
      "<tr>" +
      "<td>" +
      escapeHtml_(item.name || "Unknown") +
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
    "<h1>INVOICE</h1>" +
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
    "<thead><tr><th>Item</th><th style='text-align:center'>Qty</th><th style='text-align:right'>Unit Price</th><th style='text-align:right'>Total</th></tr></thead>" +
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
    "<div class='footer'>Thank you for your business!</div>" +
    "</body></html>"
  );
}

/* ================================================================
   FIFO Allocation Engine
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

function allocateSaleBatches_(saleId, itemId, quantityToSell) {
  var qty = toNumber_(quantityToSell);
  if (qty <= 0) return [];

  var todayStr = formatSheetDate_(new Date());
  var purchases = getPurchaseRecords_().filter(function (p) {
    var isExpired = p.expiryDate && p.expiryDate < todayStr;
    return (
      normalizeText_(p.itemId) === normalizeText_(itemId) &&
      toNumber_(p.remainingQuantity) > 0 &&
      !isExpired
    );
  });

  purchases.sort(function (a, b) {
    var dateA = new Date(a.expiryDate || "9999-12-31").getTime();
    var dateB = new Date(b.expiryDate || "9999-12-31").getTime();
    return dateA - dateB;
  });

  var purchaseSheet = getPurchasesSheet_();
  var allocSheet = getSalesAllocationsSheet_();
  var now = formatDateTime_(new Date());

  var allocations = [];

  for (var i = 0; i < purchases.length; i++) {
    if (qty <= 0) break;

    var batch = purchases[i];
    var available = toNumber_(batch.remainingQuantity);
    if (available <= 0) continue;

    var consumed = Math.min(available, qty);
    if (consumed <= 0) continue;

    // update Purchases remainingQuantity column (column 13 in Purchases sheet)
    var remainingCol = 13;
    purchaseSheet
      .getRange(batch._rowNumber, remainingCol, 1, 1)
      .setValue(available - consumed);

    // record allocation
    var allocId = "ALC-" + Utilities.getUuid().split("-")[0].toUpperCase();
    allocSheet.appendRow([
      allocId,
      saleId,
      itemId,
      batch.id,
      batch._rowNumber,
      consumed,
      now,
      now,
    ]);

    allocations.push({
      id: allocId,
      saleId: saleId,
      itemId: itemId,
      purchaseId: batch.id,
      batchRowNumber: batch._rowNumber,
      consumedQuantity: consumed,
    });

    qty -= consumed;
  }

  if (qty > 0) {
    throw new Error("Insufficient stock for this sale.");
  }

  return allocations;
}

function restoreSaleAllocations_(saleId) {
  var allocHeaders = [
    "ID",
    "SaleID",
    "ItemID",
    "PurchaseID",
    "BatchRowNumber",
    "ConsumedQuantity",
    "CreatedAt",
    "UpdatedAt",
  ];
  var allocs = getSheetRecords_("SalesAllocations", allocHeaders).map(
    function (r) {
      return {
        saleId: normalizeText_(r.SaleID),
        purchaseId: normalizeText_(r.PurchaseID),
        batchRowNumber: toNumber_(r.BatchRowNumber),
        consumedQuantity: toNumber_(r.ConsumedQuantity),
        _rowNumber: r._rowNumber,
      };
    },
  );

  var allocations = allocs.filter(function (a) {
    return a.saleId === normalizeText_(saleId);
  });

  if (!allocations.length) return;

  var purchaseSheet = getPurchasesSheet_();

  // restore each consumed batch
  allocations.forEach(function (a) {
    var batchRow = a.batchRowNumber;
    var remainingCol = 13;
    var currentRemaining = toNumber_(
      purchaseSheet.getRange(batchRow, remainingCol, 1, 1).getValue(),
    );
    var restored = currentRemaining + toNumber_(a.consumedQuantity);
    purchaseSheet.getRange(batchRow, remainingCol, 1, 1).setValue(restored);
  });

  // remove allocation records
  var allocSheet = getSalesAllocationsSheet_();
  for (var i = allocations.length - 1; i >= 0; i -= 1) {
    allocSheet.deleteRow(allocations[i]._rowNumber);
  }

  // PERFORMANCE: Invalidate stock map cache since remaining quantities changed
  invalidateStockMapCache_();
}
