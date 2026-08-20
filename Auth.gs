/* ============================================================
   AUTH MODULE — Auth.gs
   Handles login, logout, session token validation via
   PropertiesService + CacheService, and role-based access assertions.
   ============================================================ */

var AUTH_CACHE_PREFIX_ = "auth_session_";
var AUTH_CACHE_TTL_ = 21600; // Apps Script cache max: 6 hours
var AUTH_SESSION_TTL_ = 2592000; // 30 days in seconds

/* ----------------------------------------------------------------
   Public API
   ---------------------------------------------------------------- */

/**
 * Called by getAppBootstrap().
 * Reads the active Google user's email, looks them up in the
 * Users sheet, and returns their name + role.
 */
function getCurrentUser() {
  var email = Session.getActiveUser().getEmail();
  var normalEmail = normalizeText_(email).toLowerCase();

  if (!normalEmail || normalEmail === "anonymous") {
    return {
      email: "anonymous",
      name: "Guest",
      role: "Staff",
      isAuthenticated: false,
    };
  }

  // Seed the sheet on first run
  var sheet = getUsersSheet_();
  seedCurrentUserIfNeeded_(sheet);

  // Look up user by Google email
  var users = getUserRecords_();
  for (var i = 0; i < users.length; i++) {
    if (users[i].email === normalEmail) {
      var u = users[i];
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        isAuthenticated: true,
      };
    }
  }

  // Google user exists but not in Users sheet – treat as Staff (read-only)
  return {
    email: normalEmail,
    name: normalEmail.split("@")[0],
    role: "Staff",
    isAuthenticated: true,
  };
}

/**
 * Log in with email + password.
 * Verifies credentials against the Users sheet, creates a
 * CacheService session token, and returns user info.
 */
function loginUser(email, rawPassword) {
  try {
    var normalEmail = normalizeText_(email).toLowerCase();
    var normalPass = normalizeText_(rawPassword);

    if (!normalEmail || !normalPass) {
      return errorResponse_("Email and password are required.");
    }

    var users = getUserRecords_();
    var found = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].email === normalEmail) {
        found = users[i];
        break;
      }
    }

    if (!found) {
      return errorResponse_("Invalid email or password.");
    }

    if (found.status !== "Active") {
      return errorResponse_(
        "Your account has been disabled. Contact the administrator.",
      );
    }

    // Verify password
    if (!found.passwordHash || !found.passwordSalt) {
      return errorResponse_(
        "Password not set for this account. Contact the administrator.",
      );
    }

    var computedHash = hashPassword_(found.passwordSalt, normalPass);
    if (computedHash !== found.passwordHash) {
      return errorResponse_("Invalid email or password.");
    }

    // Create session token
    var token = Utilities.getUuid();
    var sessionData = JSON.stringify({
      userId: found.id,
      email: found.email,
      name: found.name,
      role: found.role,
      expiresAt: Date.now() + AUTH_SESSION_TTL_ * 1000,
    });
    CacheService.getScriptCache().put(
      AUTH_CACHE_PREFIX_ + token,
      sessionData,
      AUTH_CACHE_TTL_,
    );
    PropertiesService.getScriptProperties().setProperty(
      AUTH_CACHE_PREFIX_ + token,
      sessionData,
    );

    return successResponse_(
      {
        token: token,
        user: {
          id: found.id,
          email: found.email,
          name: found.name,
          role: found.role,
        },
      },
      "Login successful.",
    );
  } catch (e) {
    return errorResponse_(e.message || "Login failed.");
  }
}

/**
 * Log out — remove session token from CacheService.
 */
function logoutUser(token) {
  try {
    if (normalizeText_(token)) {
      var key = AUTH_CACHE_PREFIX_ + normalizeText_(token);
      CacheService.getScriptCache().remove(key);
      PropertiesService.getScriptProperties().deleteProperty(key);
    }
    return successResponse_(null, "Logged out successfully.");
  } catch (e) {
    return errorResponse_(e.message || "Logout failed.");
  }
}

/**
 * Register a new user.
 * Self-registration always creates an active Staff account; Admin users can
 * promote Staff from the Users page after reviewing the account.
 * payload: { name, email, password }
 */
function registerUser(payload) {
  return errorResponse_(
    "Registration is disabled. Please contact the administrator.",
  );
}

/**
 * Change a user's own password.
 * token: active session token
 */
function changePassword(token, currentPassword, newPassword) {
  try {
    var session = validateSessionToken_(token);
    var users = getUserRecords_();
    var found = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === session.userId) {
        found = users[i];
        break;
      }
    }
    if (!found) return errorResponse_("User not found.");

    var computedHash = hashPassword_(
      found.passwordSalt,
      normalizeText_(currentPassword),
    );
    if (computedHash !== found.passwordHash) {
      return errorResponse_("Current password is incorrect.");
    }

    var newNorm = normalizeText_(newPassword);
    if (!newNorm || newNorm.length < 6) {
      return errorResponse_("New password must be at least 6 characters.");
    }

    var newSalt = Utilities.getUuid();
    var newHash = hashPassword_(newSalt, newNorm);
    setUserPassword_(found.id, newSalt, newHash);

    // Invalidate ALL existing session tokens for this user
    var props = PropertiesService.getScriptProperties().getProperties();
    var keysToDelete = [];
    Object.keys(props).forEach(function (key) {
      if (key.indexOf(AUTH_CACHE_PREFIX_) === 0) {
        try {
          var data = JSON.parse(props[key]);
          if (data && data.userId === found.id) {
            keysToDelete.push(key);
            CacheService.getScriptCache().remove(key);
          }
        } catch (e) {}
      }
    });
    if (keysToDelete.length) {
      keysToDelete.forEach(function (k) {
        PropertiesService.getScriptProperties().deleteProperty(k);
      });
    }

    return successResponse_(null, "Password changed successfully.");
  } catch (e) {
    return errorResponse_(e.message || "Failed to change password.");
  }
}

/* ----------------------------------------------------------------
   Internal helpers (not directly callable from client)
   ---------------------------------------------------------------- */

/**
 * Validate a session token from cache/persistent script properties.
 * Returns { userId, email, name, role } or throws.
 */
function validateSessionToken_(token) {
  var norm = normalizeText_(token);
  if (!norm) throw new Error("Session token is required.");

  var key = AUTH_CACHE_PREFIX_ + norm;
  var cached = CacheService.getScriptCache().get(key);
  var sessionJson =
    cached || PropertiesService.getScriptProperties().getProperty(key);
  if (!sessionJson) throw new Error("Session expired. Please log in again.");

  var session = JSON.parse(sessionJson);
  if (session.expiresAt && Number(session.expiresAt) <= Date.now()) {
    CacheService.getScriptCache().remove(key);
    PropertiesService.getScriptProperties().deleteProperty(key);
    throw new Error("Session expired. Please log in again.");
  }

  if (!cached) {
    CacheService.getScriptCache().put(key, sessionJson, AUTH_CACHE_TTL_);
  }

  return session;
}

/**
 * Assert that the current session token belongs to an Admin.
 * Throws an error if the role is not Admin.
 */
function assertAdminRole_(token) {
  return assertAuthenticatedRole_(token, ["Admin"]);
}

/**
 * Assert that the current session token belongs to an active allowed role.
 */
function assertAuthenticatedRole_(token, allowedRoles) {
  var session = validateSessionToken_(token);
  var roles = allowedRoles || [];

  var user = findUserById_(session.userId);
  if (!user || user.status !== "Active") {
    throw new Error("Session user is inactive or no longer exists.");
  }

  if (roles.length && roles.indexOf(user.role) === -1) {
    throw new Error("Access denied: insufficient privileges.");
  }

  session.role = user.role;
  session.name = user.name;
  session.email = user.email;
  return session;
}

/**
 * Hash a password using SHA-256: hash(salt + rawPassword).
 */
function hashPassword_(salt, rawPassword) {
  var input = salt + rawPassword;
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return bytes
    .map(function (b) {
      return ("0" + (b & 0xff).toString(16)).slice(-2);
    })
    .join("");
}
