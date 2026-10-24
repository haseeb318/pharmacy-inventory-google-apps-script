/**
 * ===================================================================
 * Suppliers Module (Phase 3 - Issue #2 Data Architecture)
 * ===================================================================
 * Normalized master sheet and API for pharmacy supplier / vendor records.
 */

function getSuppliersPageMeta(token) {
  assertAdminRole_(token);
  return successResponse_({
    sheetName: "Suppliers",
    module: "Suppliers",
    headers: getSuppliersHeaders_(),
  });
}

function getSuppliersHeaders_() {
  return [
    "ID",
    "Name",
    "ContactPerson",
    "Phone",
    "Email",
    "Address",
    "Notes",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getSuppliersSheet_() {
  return getOrCreateSheet_("Suppliers", getSuppliersHeaders_());
}

function getSupplierRecords_() {
  return getCachedRecords_(
    "supplierRecords",
    "Suppliers",
    getSuppliersHeaders_(),
  ).map(function (r) {
    return {
      id: normalizeText_(r.ID),
      name: normalizeText_(r.Name),
      contactPerson: normalizeText_(r.ContactPerson),
      phone: normalizeText_(r.Phone),
      email: normalizeText_(r.Email),
      address: normalizeText_(r.Address),
      notes: normalizeText_(r.Notes),
      createdAt: normalizeText_(r.CreatedAt),
      updatedAt: normalizeText_(r.UpdatedAt),
      _rowNumber: r._rowNumber,
    };
  });
}

function getSuppliers(token) {
  assertAdminRole_(token);
  return successResponse_({
    suppliers: getSupplierRecords_(),
  });
}

function getSuppliersMasterList(token) {
  assertAdminRole_(token);
  var records = getSupplierRecords_();
  var list = records.map(function (s) {
    return {
      id: s.id,
      name: s.name,
      contactPerson: s.contactPerson,
      phone: s.phone,
    };
  });
  return successResponse_({ suppliers: list });
}

function findSupplierById_(id) {
  var normalizedId = normalizeText_(id);
  if (!normalizedId) return null;
  var suppliers = getSupplierRecords_();
  for (var i = 0; i < suppliers.length; i++) {
    if (suppliers[i].id === normalizedId) {
      return suppliers[i];
    }
  }
  return null;
}

function findSupplierByName_(name) {
  var normalizedName = normalizeText_(name);
  if (!normalizedName) return null;
  var suppliers = getSupplierRecords_();
  for (var i = 0; i < suppliers.length; i++) {
    if (suppliers[i].name.toLowerCase() === normalizedName.toLowerCase()) {
      return suppliers[i];
    }
  }
  return null;
}

function createSupplierId_() {
  return "SUP-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

function validateSupplierPayload_(payload) {
  var data = payload || {};
  var name = normalizeText_(data.name || "");

  if (!name) {
    throw new Error("Supplier name is required.");
  }

  return {
    name: name,
    contactPerson: normalizeText_(data.contactPerson || ""),
    phone: normalizeText_(data.phone || ""),
    email: normalizeText_(data.email || ""),
    address: normalizeText_(data.address || ""),
    notes: normalizeText_(data.notes || ""),
  };
}

function createSupplier(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var supplier = validateSupplierPayload_(payload);
    var sheet = getSuppliersSheet_();
    var now = formatDateTime_(new Date());
    var supplierId = createSupplierId_();

    sheet.appendRow([
      supplierId,
      supplier.name,
      supplier.contactPerson,
      supplier.phone,
      supplier.email,
      supplier.address,
      supplier.notes,
      now,
      now,
    ]);

    invalidateDataCache_();

    return successResponse_({
      supplier: {
        id: supplierId,
        name: supplier.name,
        contactPerson: supplier.contactPerson,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        notes: supplier.notes,
        createdAt: now,
        updatedAt: now,
      },
    }, "Supplier created successfully.");
  } finally {
    lock.releaseLock();
  }
}

function updateSupplier(id, payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var supplierId = normalizeText_(id);
    var existing = findSupplierById_(supplierId);
    if (!existing) {
      throw new Error("Supplier was not found.");
    }

    var supplier = validateSupplierPayload_(payload);
    var sheet = getSuppliersSheet_();
    var headers = getSuppliersHeaders_();
    var now = formatDateTime_(new Date());

    var rowValues = [];
    for (var h = 0; h < headers.length; h++) {
      var header = headers[h];
      if (header === "ID") rowValues.push(supplierId);
      else if (header === "Name") rowValues.push(supplier.name);
      else if (header === "ContactPerson") rowValues.push(supplier.contactPerson);
      else if (header === "Phone") rowValues.push(supplier.phone);
      else if (header === "Email") rowValues.push(supplier.email);
      else if (header === "Address") rowValues.push(supplier.address);
      else if (header === "Notes") rowValues.push(supplier.notes);
      else if (header === "CreatedAt") rowValues.push(existing.createdAt || now);
      else if (header === "UpdatedAt") rowValues.push(now);
      else rowValues.push("");
    }

    sheet.getRange(existing._rowNumber, 1, 1, rowValues.length).setValues([rowValues]);

    invalidateDataCache_();

    return successResponse_({
      supplier: {
        id: supplierId,
        name: supplier.name,
        contactPerson: supplier.contactPerson,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        notes: supplier.notes,
        updatedAt: now,
      },
    }, "Supplier updated successfully.");
  } finally {
    lock.releaseLock();
  }
}
