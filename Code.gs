var APP_CONFIG = {
  name: "Inventory Management System",
  version: "1.0.0",
  defaultPage: "dashboard",
  timezone: Session.getScriptTimeZone(),
};

function doGet() {
  return HtmlService.createTemplateFromFile("index")
    .evaluate()
    .setTitle(APP_CONFIG.name)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getAppBootstrap(token) {
  var user = null;
  if (normalizeText_(token)) {
    var session = assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    user = {
      id: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      isAuthenticated: true,
    };
  } else {
    user = getCurrentUser();
  }

  return successResponse_({
    app: APP_CONFIG,
    user: user,
  });
}

function serverPing() {
  return successResponse_({
    ok: true,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Creates custom menu in Google Sheets UI for administrators.
 */
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu("💊 Pharmacy Admin")
      .addItem("🔍 Check Database Integrity", "menuCheckDatabaseIntegrity_")
      .addItem("🛡️ Setup Sheet Validations & Protections", "menuSetupValidations_")
      .addItem("🔄 Reconcile Sales Financials", "menuReconcileSalesTotals_")
      .addItem("🛠️ Repair Database Issues", "menuRepairDatabase_")
      .addSeparator()
      .addItem("👥 Populate Customers & Suppliers from History", "menuMigrateCustomersAndSuppliers_")
      .addToUi();
  } catch (e) {
    // Silent when run from Web App execution context where getUi() is unavailable
  }
}

function menuCheckDatabaseIntegrity_() {
  var ui = SpreadsheetApp.getUi();
  var res = checkDatabaseIntegrity();
  if (res.data.healthy) {
    ui.alert("Database Status", "✅ Database is healthy! No orphaned records, broken sales, or negative stock found.", ui.ButtonSet.OK);
  } else {
    var issues = res.data.issues;
    var msg = "⚠️ Integrity Issues Detected:\n" +
      "- Negative Stock Batches: " + issues.negativeStockPurchases.length + "\n" +
      "- Orphaned Sale Items: " + issues.orphanedSaleItems.length + "\n" +
      "- Orphaned Allocations: " + issues.orphanedAllocations.length + "\n" +
      "- Broken Sales: " + issues.brokenSales.length + "\n" +
      "- Financial Mismatches: " + issues.financialMismatches.length + "\n\n" +
      "Run 'Repair Database Issues' to resolve recoverable items.";
    ui.alert("Integrity Scan Results", msg, ui.ButtonSet.OK);
  }
}

function menuSetupValidations_() {
  var ui = SpreadsheetApp.getUi();
  setupDatabaseValidations();
  protectDatabaseHeaders();
  ui.alert("Complete", "✅ Sheet data validations and header protections successfully configured across all tables.", ui.ButtonSet.OK);
}

function menuReconcileSalesTotals_() {
  var ui = SpreadsheetApp.getUi();
  var rep = reconcileSalesTotals(true);
  ui.alert("Financial Reconciliation", "Sales checked: " + rep.data.totalSalesChecked + "\nRepaired mismatches: " + rep.data.fixed, ui.ButtonSet.OK);
}

function menuRepairDatabase_() {
  var ui = SpreadsheetApp.getUi();
  var res = repairDatabaseIntegrity();
  ui.alert("Repair Complete", "✅ " + res.data.message + "\nOrphaned allocations removed: " + res.data.repairs.orphanedAllocationsRemoved + "\nFinancial totals synced: " + res.data.repairs.financialTotalsSynced, ui.ButtonSet.OK);
}

function menuMigrateCustomersAndSuppliers_() {
  var ui = SpreadsheetApp.getUi();
  var res = migrateExtractCustomersAndSuppliers();
  if (res.success) {
    ui.alert("Migration Complete", "✅ " + res.data.message + "\n- Customers Created: " + res.data.customersCreated + "\n- Suppliers Created: " + res.data.suppliersCreated, ui.ButtonSet.OK);
  } else {
    ui.alert("Migration Error", res.message || "Failed to migrate.", ui.ButtonSet.OK);
  }
}
