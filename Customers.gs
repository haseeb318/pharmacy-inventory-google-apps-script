/**
 * ===================================================================
 * Customers Module (Phase 3 - Issue #2 Data Architecture)
 * ===================================================================
 * Normalized master sheet and API for pharmacy customer records.
 */

function getCustomersPageMeta(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  return successResponse_({
    sheetName: "Customers",
    module: "Customers",
    headers: getCustomersHeaders_(),
  });
}

function getCustomersHeaders_() {
  return [
    "ID",
    "Name",
    "Phone",
    "Email",
    "Address",
    "Notes",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getCustomersSheet_() {
  return getOrCreateSheet_("Customers", getCustomersHeaders_());
}

function getCustomerRecords_() {
  return getCachedRecords_(
    "customerRecords",
    "Customers",
    getCustomersHeaders_(),
  ).map(function (r) {
    return {
      id: normalizeText_(r.ID),
      name: normalizeText_(r.Name),
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

function getCustomers(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  return successResponse_({
    customers: getCustomerRecords_(),
  });
}

function getCustomersList(token) {
  assertAuthenticatedRole_(token, ["Admin", "Staff"]);
  var records = getCustomerRecords_();
  var list = records.map(function (c) {
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
    };
  });
  return successResponse_({ customers: list });
}

function findCustomerById_(id) {
  var normalizedId = normalizeText_(id);
  if (!normalizedId) return null;
  var customers = getCustomerRecords_();
  for (var i = 0; i < customers.length; i++) {
    if (customers[i].id === normalizedId) {
      return customers[i];
    }
  }
  return null;
}

function findCustomerByPhone_(phone) {
  var normalizedPhone = normalizeText_(phone);
  if (!normalizedPhone) return null;
  var customers = getCustomerRecords_();
  for (var i = 0; i < customers.length; i++) {
    if (customers[i].phone === normalizedPhone) {
      return customers[i];
    }
  }
  return null;
}

function createCustomerId_() {
  return "CUST-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

function validateCustomerPayload_(payload) {
  var data = payload || {};
  var name = normalizeText_(data.name || "");
  var phone = normalizeText_(data.phone || "");

  if (!name) {
    throw new Error("Customer name is required.");
  }

  return {
    name: name,
    phone: phone,
    email: normalizeText_(data.email || ""),
    address: normalizeText_(data.address || ""),
    notes: normalizeText_(data.notes || ""),
  };
}

function createCustomer(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var customer = validateCustomerPayload_(payload);
    var sheet = getCustomersSheet_();
    var now = formatDateTime_(new Date());
    var customerId = createCustomerId_();

    sheet.appendRow([
      customerId,
      customer.name,
      customer.phone,
      customer.email,
      customer.address,
      customer.notes,
      now,
      now,
    ]);

    invalidateDataCache_();

    return successResponse_({
      customer: {
        id: customerId,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        notes: customer.notes,
        createdAt: now,
        updatedAt: now,
      },
    }, "Customer created successfully.");
  } finally {
    lock.releaseLock();
  }
}

function updateCustomer(id, payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAuthenticatedRole_(token, ["Admin", "Staff"]);
    var customerId = normalizeText_(id);
    var existing = findCustomerById_(customerId);
    if (!existing) {
      throw new Error("Customer was not found.");
    }

    var customer = validateCustomerPayload_(payload);
    var sheet = getCustomersSheet_();
    var headers = getCustomersHeaders_();
    var now = formatDateTime_(new Date());

    var rowValues = [];
    for (var h = 0; h < headers.length; h++) {
      var header = headers[h];
      if (header === "ID") rowValues.push(customerId);
      else if (header === "Name") rowValues.push(customer.name);
      else if (header === "Phone") rowValues.push(customer.phone);
      else if (header === "Email") rowValues.push(customer.email);
      else if (header === "Address") rowValues.push(customer.address);
      else if (header === "Notes") rowValues.push(customer.notes);
      else if (header === "CreatedAt") rowValues.push(existing.createdAt || now);
      else if (header === "UpdatedAt") rowValues.push(now);
      else rowValues.push("");
    }

    sheet.getRange(existing._rowNumber, 1, 1, rowValues.length).setValues([rowValues]);

    invalidateDataCache_();

    return successResponse_({
      customer: {
        id: customerId,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        notes: customer.notes,
        updatedAt: now,
      },
    }, "Customer updated successfully.");
  } finally {
    lock.releaseLock();
  }
}
