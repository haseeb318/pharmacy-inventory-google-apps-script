function getUsersPageMeta(token) {
  assertAdminRole_(token);
  return successResponse_({
    sheetName: "Users",
    module: "Users",
    headers: getUsersHeaders_(),
    roles: getUserRoles_(),
    statuses: getUserStatuses_(),
  });
}

function getUsers(token) {
  assertAdminRole_(token);
  return successResponse_(buildUsersPayload_());
}

function buildUsersPayload_() {
  var sheet = getUsersSheet_();
  seedCurrentUserIfNeeded_(sheet);

  return {
    users: getUserRecords_(),
    roles: getUserRoles_(),
    statuses: getUserStatuses_(),
  };
}

function createUser(payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    createUserRecord_(payload);
    return successResponse_(buildUsersPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function createUserRecord_(payload) {
  var sheet = getUsersSheet_();
  var user = validateUserPayload_(payload, "");
  var now = formatDateTime_(new Date());

  assertUniqueUserEmail_(user.email, "");

  var passwordSalt = normalizeText_(
    payload && payload.passwordSalt ? payload.passwordSalt : "",
  );
  var passwordHash = normalizeText_(
    payload && payload.passwordHash ? payload.passwordHash : "",
  );

  if (
    !passwordHash &&
    payload &&
    payload.password &&
    payload.password.length >= 6
  ) {
    passwordSalt = Utilities.getUuid();
    passwordHash = hashPassword_(
      passwordSalt,
      normalizeText_(payload.password),
    );
  }

  sheet.appendRow([
    createUserId_(),
    user.name,
    user.email,
    user.role,
    user.status,
    passwordHash,
    passwordSalt,
    now,
    now,
  ]);
}

function updateUser(id, payload, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var userId = normalizeText_(id);
    var sheet = getUsersSheet_();
    var existing = findUserById_(userId);
    var user = validateUserPayload_(payload, userId);
    var now = formatDateTime_(new Date());

    if (!existing) {
      throw new Error("User was not found.");
    }

    assertUniqueUserEmail_(user.email, userId);
    assertAdministratorAvailability_(userId, user.role, user.status);

    // Keep existing password unless a new one is being set
    var passwordSalt = existing.passwordSalt || "";
    var passwordHash = existing.passwordHash || "";
    if (payload && payload.password && payload.password.length >= 6) {
      passwordSalt = Utilities.getUuid();
      passwordHash = hashPassword_(
        passwordSalt,
        normalizeText_(payload.password),
      );
    } else if (payload && payload.passwordSalt && payload.passwordHash) {
      passwordSalt = normalizeText_(payload.passwordSalt);
      passwordHash = normalizeText_(payload.passwordHash);
    }

    sheet
      .getRange(existing._rowNumber, 1, 1, getUsersHeaders_().length)
      .setValues([
        [
          userId,
          user.name,
          user.email,
          user.role,
          user.status,
          passwordHash,
          passwordSalt,
          existing.createdAt || now,
          now,
        ],
      ]);

    return successResponse_(buildUsersPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function deleteUser(id, token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    assertAdminRole_(token);
    var userId = normalizeText_(id);
    var sheet = getUsersSheet_();
    var existing = findUserById_(userId);

    if (!existing) {
      throw new Error("User was not found.");
    }

    assertAdministratorAvailability_(userId, "Deleted", "Inactive");
    sheet.deleteRow(existing._rowNumber);

    return successResponse_(buildUsersPayload_());
  } catch (error) {
    return errorResponse_(error.message);
  } finally {
    lock.releaseLock();
  }
}

function getUsersHeaders_() {
  return [
    "ID",
    "Name",
    "Email",
    "Role",
    "Status",
    "PasswordHash",
    "PasswordSalt",
    "CreatedAt",
    "UpdatedAt",
  ];
}

function getUserRoles_() {
  return ["Admin", "Staff"];
}

function getUserStatuses_() {
  return ["Active", "Inactive"];
}

function getUsersSheet_() {
  return getOrCreateSheet_("Users", getUsersHeaders_());
}

function getUserRecords_() {
  return getSheetRecords_("Users", getUsersHeaders_()).map(function (record) {
    return {
      id: normalizeText_(record.ID),
      name: normalizeText_(record.Name),
      email: normalizeText_(record.Email).toLowerCase(),
      role: normalizeText_(record.Role),
      status: normalizeText_(record.Status),
      passwordHash: normalizeText_(record.PasswordHash),
      passwordSalt: normalizeText_(record.PasswordSalt),
      createdAt: normalizeText_(record.CreatedAt),
      updatedAt: normalizeText_(record.UpdatedAt),
      _rowNumber: record._rowNumber,
    };
  });
}

function seedCurrentUserIfNeeded_(sheet) {
  if (sheet.getLastRow() > 1) {
    return;
  }

  var email = Session.getActiveUser().getEmail();
  var normalEmail = normalizeText_(email).toLowerCase();

  if (!normalEmail || normalEmail === "anonymous") {
    return;
  }

  var now = formatDateTime_(new Date());
  sheet.appendRow([
    createUserId_(),
    normalEmail.split("@")[0],
    normalEmail,
    "Admin",
    "Active",
    "", // PasswordHash (empty until set via Users page)
    "", // PasswordSalt
    now,
    now,
  ]);
}

function validateUserPayload_(payload, existingId) {
  var data = payload || {};
  var user = {
    name: normalizeText_(data.name),
    email: normalizeText_(data.email).toLowerCase(),
    role: normalizeText_(data.role),
    status: normalizeText_(data.status),
  };

  if (user.name.length < 2) {
    throw new Error("Name must be at least 2 characters.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
    throw new Error("Enter a valid email address.");
  }

  if (getUserRoles_().indexOf(user.role) === -1) {
    throw new Error("Select a valid role.");
  }

  if (getUserStatuses_().indexOf(user.status) === -1) {
    throw new Error("Select a valid status.");
  }

  if (existingId && !findUserById_(existingId)) {
    throw new Error("User was not found.");
  }

  return user;
}

function assertUniqueUserEmail_(email, currentUserId) {
  var normalizedEmail = normalizeText_(email).toLowerCase();
  var normalizedId = normalizeText_(currentUserId);
  var duplicate = getUserRecords_().some(function (user) {
    return user.email === normalizedEmail && user.id !== normalizedId;
  });

  if (duplicate) {
    throw new Error("A user with this email already exists.");
  }
}

function assertAdministratorAvailability_(
  changingUserId,
  nextRole,
  nextStatus,
) {
  var remainingAdmins = getUserRecords_().filter(function (user) {
    if (user.id === changingUserId) {
      return nextRole === "Admin" && nextStatus === "Active";
    }
    return user.role === "Admin" && user.status === "Active";
  });

  if (remainingAdmins.length === 0) {
    throw new Error("At least one active Admin is required.");
  }
}

function findUserById_(id) {
  var userId = normalizeText_(id);
  var users = getUserRecords_();

  for (var index = 0; index < users.length; index += 1) {
    if (users[index].id === userId) {
      return users[index];
    }
  }

  return null;
}

function createUserId_() {
  return "USR-" + Utilities.getUuid().split("-")[0].toUpperCase();
}

function setUserPassword_(userId, salt, hash) {
  var sheet = getUsersSheet_();
  var existing = findUserById_(userId);
  if (!existing) throw new Error("User not found.");

  var now = formatDateTime_(new Date());
  // Column 6 is PasswordHash, Column 7 is PasswordSalt, Column 9 is UpdatedAt
  sheet.getRange(existing._rowNumber, 6, 1, 2).setValues([[hash, salt]]);
  sheet.getRange(existing._rowNumber, 9, 1, 1).setValue(now);
}
