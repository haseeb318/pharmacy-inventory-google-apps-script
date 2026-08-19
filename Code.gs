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
