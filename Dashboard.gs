/* ================================================================
   DASHBOARD MODULE — Dashboard.gs
   Provides KPIs, recent transactions, low-stock warnings, and
   expiring batch alerts using cached records and lookup maps.
   ================================================================ */

function getDashboardOverview(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  try {
    return successResponse_(buildDashboardOverviewPayload_());
  } catch (error) {
    return errorResponse_(
      error.message || "Unable to compute dashboard overview.",
    );
  }
}

function buildDashboardOverviewPayload_() {
  var items = getItemRecords_();
  var sales = getSalesRecords_();
  var purchases = getPurchaseRecords_();

  var stockMap = buildItemStockMap_();
  var itemMap = buildItemLookupMap_();

  // Compute KPIs using maps
  var totalSales = sales.reduce(function (t, s) {
    return t + toNumber_(s.totalAmount);
  }, 0);
  var totalPurchases = purchases.reduce(function (t, p) {
    return t + toNumber_(p.totalCost);
  }, 0);

  // Low stock: iterate items once using stock map
  var lowStockItems = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var minStock = toNumber_(item.minimumStock);
    var currentStock =
      item.currentStock !== undefined
        ? toNumber_(item.currentStock)
        : stockMap[item.id] || 0;
    if (minStock > 0 && currentStock <= minStock) {
      lowStockItems.push({
        itemId: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit || "",
        currentStock: currentStock,
        minimumStock: minStock,
        shortage: Math.max(minStock - currentStock, 0),
      });
    }
  }
  lowStockItems.sort(function (a, b) {
    return b.shortage - a.shortage;
  });

  // Recent sales (last 5)
  var recentSales = sales
    .map(function (s) {
      return {
        id: s.invoiceNumber || s.id,
        date: s.saleDate || s.createdAt || "",
        partyName: s.customerName || "Walk-in",
        totalAmount: toNumber_(s.totalAmount),
        status: s.status || "Completed",
      };
    })
    .sort(function (a, b) {
      var dateA = a.date ? new Date(a.date).getTime() : 0;
      var dateB = b.date ? new Date(b.date).getTime() : 0;
      if (isNaN(dateA)) dateA = 0;
      if (isNaN(dateB)) dateB = 0;
      return dateB - dateA;
    })
    .slice(0, 5);

  // Recent purchases (last 5)
  var recentPurchases = purchases
    .map(function (p) {
      return {
        id: p.id,
        date: p.purchaseDate || p.createdAt || "",
        partyName: p.supplier || "Unknown",
        totalAmount: toNumber_(p.totalCost),
        status: "Completed",
      };
    })
    .sort(function (a, b) {
      var dateA = a.date ? new Date(a.date).getTime() : 0;
      var dateB = b.date ? new Date(b.date).getTime() : 0;
      if (isNaN(dateA)) dateA = 0;
      if (isNaN(dateB)) dateB = 0;
      return dateB - dateA;
    })
    .slice(0, 5);

  // Expiring batches (single pass, within 60 days)
  var now = new Date().getTime();
  var EXPIRY_THRESHOLD_DAYS = 60;
  var threshold = now + EXPIRY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  var expiringBatches = [];
  for (var pi = 0; pi < purchases.length; pi++) {
    var p = purchases[pi];
    if (toNumber_(p.remainingQuantity) <= 0 || !p.expiryDate) continue;
    var expTime = new Date(p.expiryDate).getTime();
    if (!isNaN(expTime) && expTime <= threshold) {
      var itemRecord = itemMap[p.itemId];
      var daysLeft = Math.ceil((expTime - now) / (1000 * 60 * 60 * 24));
      expiringBatches.push({
        batchNumber: p.batchNumber || p.id,
        itemId: p.itemId,
        itemName: itemRecord ? itemRecord.name : "Unknown",
        remainingQuantity: toNumber_(p.remainingQuantity),
        expiryDate: p.expiryDate,
        daysToExpiry: daysLeft,
      });
    }
  }
  expiringBatches.sort(function (a, b) {
    return a.daysToExpiry - b.daysToExpiry;
  });

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalItems: items.length,
      totalSales: totalSales,
      totalPurchases: totalPurchases,
      lowStockItems: lowStockItems.length,
    },
    recentSales: recentSales.slice(0, 5),
    recentPurchases: recentPurchases.slice(0, 5),
    lowStockItems: lowStockItems.slice(0, 8),
    expiringBatches: expiringBatches.slice(0, 8),
    chartSummary: {
      salesCount: sales.length,
      purchasesCount: purchases.length,
      salesTotal: totalSales,
      purchasesTotal: totalPurchases,
    },
  };
}
