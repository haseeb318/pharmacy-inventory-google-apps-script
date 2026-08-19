function getItemsPageMeta(token) {
  assertAdminRole_(token);
  return successResponse_({
    sheetName: "Items",
    module: "Items",
    headers: getItemsHeaders_(),
    categories: getItemCategories_(),
    units: getItemUnits_(),
  });
}

/* ================================================================
   PERFORMANCE: Lightweight items list for dropdowns (no stock calc)
   Returns only id + name for select/autocomplete components
   ================================================================ */
function getItemsList() {
  var items = getCachedRecords_("itemsList", "Items", getItemsHeaders_());
  var list = items.map(function (r) {
    return {
      id: normalizeText_(r.ID),
      name: normalizeText_(r.Name),
    };
  });
  return successResponse_({ items: list });
}

function getItems(token) {
  assertAdminRole_(token);
  return successResponse_(buildItemsPayload_());
}

function buildItemsPayload_() {
  var sheet = getItemsSheet_();

  return {
    items: getItemRecords_(),
    categories: getItemCategories_(),
    units: getItemUnits_(),
  };
}

function createItem(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var sheet = getItemsSheet_();
    var item = validateItemPayload_(payload, "");
    var now = formatDateTime_(new Date());

    sheet.appendRow([
      createItemId_(),
      item.name,
      item.description,
      item.category,
      item.unit,
      item.imageUrl,
      toNumber_(item.costPrice),
      toNumber_(item.sellingPrice),
      item.status,
      toNumber_(item.minimumStock),
      item.manufacturer,
      item.shelfLocation,
      now,
      now,
    ]);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateItemLookupMapCache_();

    return successResponse_(buildItemsPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function updateItem(id, payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var itemId = normalizeText_(id);
    var sheet = getItemsSheet_();
    var existing = findItemById_(itemId);
    var item = validateItemPayload_(payload, itemId);
    var now = formatDateTime_(new Date());

    if (!existing) {
      throw new Error("Item was not found.");
    }

    sheet
      .getRange(existing._rowNumber, 1, 1, getItemsHeaders_().length)
      .setValues([
        [
          itemId,
          item.name,
          item.description,
          item.category,
          item.unit,
          item.imageUrl,
          toNumber_(item.costPrice),
          toNumber_(item.sellingPrice),
          item.status,
          toNumber_(item.minimumStock),
          item.manufacturer,
          item.shelfLocation,
          existing.createdAt || now,
          now,
        ],
      ]);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateItemLookupMapCache_();

    return successResponse_(buildItemsPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function deleteItem(id, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var itemId = normalizeText_(id);
    var sheet = getItemsSheet_();
    var existing = findItemById_(itemId);

    if (!existing) {
      throw new Error("Item was not found.");
    }

    sheet.deleteRow(existing._rowNumber);

    // PERFORMANCE: Invalidate caches after mutation
    invalidateDataCache_();
    invalidateItemLookupMapCache_();

    return successResponse_(buildItemsPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function getItemsHeaders_() {
  return [
    "ID",
    "Name",
    "Description",
    "Category",
    "Unit",
    "ImageUrl",
    "CostPrice",
    "SellingPrice",
    "Status",

    "MinimumStock",
    "Manufacturer",
    "ShelfLocation",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getItemCategories_() {
  return [
    "Tablet",
    "Capsule",
    "Injection",
    "Syrup",
    "Cream",
    "Ointment",
    "Eye Drops",
    "Ear Drops",
    "Powder",
    "Other",
  ];
}

function getItemUnits_() {
  return [
    "Piece",
    "Box",
    "Pack",
    "Carton",
    "Bag",
    "Bottle",
    "Can",
    "Kg",
    "Liter",
    "Meter",
    "Unit",
  ];
}

function getItemsSheet_() {
  return getOrCreateSheet_("Items", getItemsHeaders_());
}

/* ================================================================
   PERFORMANCE: Single-pass stock map
   Builds a hash map of itemId -> total remaining quantity from purchases
   in ONE loop instead of N loops (N = number of items).
   ================================================================ */
var itemStockMapCache_ = null;

function buildItemStockMap_() {
  // Return cached map if available (cache is invalidated on purchase/sale changes)
  if (itemStockMapCache_ !== null) {
    return itemStockMapCache_;
  }

  var purchases = getPurchaseRecords_();
  var map = {};

  for (var i = 0; i < purchases.length; i++) {
    var p = purchases[i];
    var id = normalizeText_(p.itemId);
    if (!map[id]) {
      map[id] = 0;
    }
    map[id] += toNumber_(p.remainingQuantity);
  }

  itemStockMapCache_ = map;
  return map;
}

function invalidateStockMapCache_() {
  itemStockMapCache_ = null;
}

/* ================================================================
   PERFORMANCE: Single-pass item lookup map
   Builds a hash map of itemId -> item record in ONE loop.
   ================================================================ */
var itemLookupMapCache_ = null;

function buildItemLookupMap_() {
  if (itemLookupMapCache_ !== null) {
    return itemLookupMapCache_;
  }

  var items = getItemRecords_();
  var map = {};

  for (var i = 0; i < items.length; i++) {
    map[items[i].id] = items[i];
  }

  itemLookupMapCache_ = map;
  return map;
}

function invalidateItemLookupMapCache_() {
  itemLookupMapCache_ = null;
}

function getItemRecords_() {
  // Build stock map ONCE for all items
  var stockMap = buildItemStockMap_();

  var records = getCachedRecords_("itemRecords", "Items", getItemsHeaders_())
    .map(function (record) {
      var minimumStock = toNumber_(record.MinimumStock);
      var costPrice = toNumber_(record.CostPrice);
      var sellingPrice = toNumber_(record.SellingPrice);
      var margin =
        costPrice > 0
          ? (((sellingPrice - costPrice) / costPrice) * 100).toFixed(2)
          : 0;

      // O(1) lookup from pre-built stock map, fallback to record stock field if missing
      var itemId = normalizeText_(record.ID);
      var currentStock =
        stockMap[itemId] !== undefined && stockMap[itemId] !== null
          ? stockMap[itemId]
          : toNumber_(
              record.CurrentStock || record.Quantity || record.Stock || 0,
            );

      return {
        id: itemId,
        name: normalizeText_(record.Name),
        description: normalizeText_(record.Description),
        category: normalizeText_(record.Category),
        unit: normalizeText_(record.Unit),
        imageUrl: normalizeText_(record.ImageUrl),
        costPrice: costPrice,
        sellingPrice: sellingPrice,
        margin: parseFloat(margin),
        minimumStock: minimumStock,
        status: normalizeText_(record.Status),
        currentStock: currentStock,
        isLowStock: currentStock <= minimumStock,
        manufacturer: normalizeText_(record.Manufacturer),
        shelfLocation: normalizeText_(record.ShelfLocation),
        createdAt: normalizeText_(record.CreatedAt),
        updatedAt: normalizeText_(record.UpdatedAt),
        _rowNumber: record._rowNumber,
      };
    })
    .reverse();

  return records;
}

// Legacy function kept for backward compatibility - no longer used internally
function sumPurchasesRemaining_(itemId) {
  var stockMap = buildItemStockMap_();
  return stockMap[normalizeText_(itemId)] || 0;
}

/* ================================================================
   PERFORMANCE: O(1) item lookup using hash map
   ================================================================ */
function findItemById_(id) {
  var itemId = normalizeText_(id);
  var map = buildItemLookupMap_();
  return map[itemId] || null;
}

function createItemId_() {
  return "ITM-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

function validateItemPayload_(payload, existingId) {
  var data = payload || {};
  var item = {
    name: normalizeText_(data.name),
    description: normalizeText_(data.description),
    category: normalizeText_(data.category),
    unit: normalizeText_(data.unit),
    imageUrl: normalizeText_(data.imageUrl),
    costPrice: toNumber_(data.costPrice),
    sellingPrice: toNumber_(data.sellingPrice),
    status: normalizeText_(data.status),

    minimumStock:
      data.minimumStock != null && data.minimumStock !== ""
        ? toNumber_(data.minimumStock)
        : 1,
    manufacturer: normalizeText_(data.manufacturer),
    shelfLocation: normalizeText_(data.shelfLocation),
  };

  if (item.name.length < 2) {
    throw new Error("Name must be at least 2 characters.");
  }

  if (getItemCategories_().indexOf(item.category) === -1) {
    throw new Error("Select a valid category.");
  }

  if (item.costPrice < 0) {
    throw new Error("Cost price cannot be negative.");
  }

  if (item.sellingPrice < 0) {
    throw new Error("Selling price cannot be negative.");
  }

  if (item.minimumStock < 0) {
    throw new Error("Minimum stock cannot be negative.");
  }

  if (item.sellingPrice > 0 && item.costPrice > item.sellingPrice) {
    throw new Error(
      "Selling price must be greater than or equal to cost price.",
    );
  }

  if (!item.status) {
    throw new Error("Status is required.");
  }

  var normalizedStatus = normalizeText_(item.status);
  if (normalizedStatus !== "Active" && normalizedStatus !== "Inactive") {
    throw new Error("Select a valid status.");
  }

  item.status = normalizedStatus;

  return item;
}
