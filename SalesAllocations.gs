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

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var saleIds = sheet
    .getRange(2, saleIdColIndex + 1, lastRow - 1, 1)
    .getValues();
  var deleteStart = 0;
  var deleteCount = 0;

  for (var i = saleIds.length - 1; i >= 0; i--) {
    if (normalizeText_(saleIds[i][0]) === normalizedSaleId) {
      deleteStart = i + 2;
      deleteCount++;
    } else if (deleteCount > 0) {
      sheet.deleteRows(deleteStart, deleteCount);
      deleteCount = 0;
    }
  }
  if (deleteCount > 0) {
    sheet.deleteRows(deleteStart, deleteCount);
  }
}
