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
  return getSheetRecords_(
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
  var sheet = getSalesAllocationsSheet_();
  var allocations = getSalesAllocationsRecords_();

  for (var i = allocations.length - 1; i >= 0; i -= 1) {
    if (allocations[i].saleId === saleId) {
      sheet.deleteRow(allocations[i]._rowNumber);
    }
  }
}
