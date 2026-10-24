function getSalesAllocationsPageMeta() {
  return successResponse_({
    module: "SalesAllocations",
    sheetName: "SalesAllocations",
    headers: getSalesAllocationsHeaders_(),
  });
}

function getSalesAllocationsHeaders_() {
  return [
    "ID",
    "SaleID",
    "ItemID",
    "PurchaseID",
    "BatchRowNumber",
    "ConsumedQuantity",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getSalesAllocationsSheet_() {
  return getOrCreateSheet_("SalesAllocations", getSalesAllocationsHeaders_());
}

function getSalesAllocationsRecords_() {
  return getCachedRecords_(
    "allocationRecords",
    "SalesAllocations",
    getSalesAllocationsHeaders_(),
  ).map(function (r) {
    return {
      id: normalizeText_(r.ID),
      saleId: normalizeText_(r.SaleID),
      itemId: normalizeText_(r.ItemID),
      purchaseId: normalizeText_(r.PurchaseID),
      batchRowNumber: toNumber_(r.BatchRowNumber),
      consumedQuantity: toNumber_(r.ConsumedQuantity),
      createdAt: normalizeText_(r.CreatedAt),
      updatedAt: normalizeText_(r.UpdatedAt),
      _rowNumber: r._rowNumber,
    };
  });
}

function deleteAllocationsBySaleId_(saleId) {
  var normalizedSaleId = normalizeText_(saleId);
  var sheet = getSalesAllocationsSheet_();
  var headers = getSalesAllocationsHeaders_();

  // Find SaleID column index
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

  if (allRows.length < 2) return;

  // PERFORMANCE: Read-filter-rewrite instead of N individual deleteRow calls
  var keepRows = [allRows[0]];
  for (var i = 1; i < allRows.length; i++) {
    if (normalizeText_(allRows[i][saleIdColIndex]) !== normalizedSaleId) {
      keepRows.push(allRows[i]);
    }
  }

  if (keepRows.length === allRows.length) return;

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
