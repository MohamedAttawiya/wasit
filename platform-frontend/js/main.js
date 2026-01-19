/* Wasit Admin UI (static)
 * - Stores config + JWT in localStorage
 * - Calls API with Authorization: Bearer <JWT>
 * - Lists users
 * - Creates user
 * - Sets role/group
 * - Builds Cognito Hosted UI login URL
 */

const $ = (id) => document.getElementById(id);

const LS = {
  apiBaseUrl: "wasit.admin.apiBaseUrl",
  jwt: "wasit.admin.jwt",
  cognitoDomain: "wasit.admin.cognitoDomain",
  clientId: "wasit.admin.clientId",
  redirectUri: "wasit.admin.redirectUri",
};

function loadState() {
  $("apiBaseUrl").value = localStorage.getItem(LS.apiBaseUrl) || "";
  $("jwt").value = localStorage.getItem(LS.jwt) || "";
  $("cognitoDomain").value = localStorage.getItem(LS.cognitoDomain) || "";
  $("clientId").value = localStorage.getItem(LS.clientId) || "";
  $("redirectUri").value = localStorage.getItem(LS.redirectUri) || window.location.href.split("#")[0];
}

function saveConfig() {
  localStorage.setItem(LS.apiBaseUrl, $("apiBaseUrl").value.trim());
  localStorage.setItem(LS.cognitoDomain, $("cognitoDomain").value.trim());
  localStorage.setItem(LS.clientId, $("clientId").value.trim());
  localStorage.setItem(LS.redirectUri, $("redirectUri").value.trim());
  updateLoginLink();
}

function saveJwt() {
  localStorage.setItem(LS.jwt, $("jwt").value.trim());
  renderClaims();
}

function clearJwt() {
  localStorage.removeItem(LS.jwt);
  $("jwt").value = "";
  renderClaims();
}

function getJwt() {
  return ($("jwt").value || "").trim();
}

function getApiBaseUrl() {
  return ($("apiBaseUrl").value || "").trim().replace(/\/+$/, "");
}

function updateLoginLink() {
  const domain = ($("cognitoDomain").value || "").trim();
  const clientId = ($("clientId").value || "").trim();
  const redirectUri = ($("redirectUri").value || "").trim();

  const a = $("loginLink");
  if (!domain || !clientId || !redirectUri) {
    a.href = "#";
    a.classList.add("disabled");
    a.title = "Fill Cognito Domain, Client ID, Redirect URL";
    return;
  }

  // Hosted UI: /login, response_type=token for quick ID token (testing)
  // You can switch to response_type=code if you implement code exchange later.
  const u = new URL(`https://${domain}/login`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "token");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("redirect_uri", redirectUri);

  a.href = u.toString();
  a.classList.remove("disabled");
  a.title = "Open Hosted UI login";
}

function parseJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const json = atob(payload);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function renderClaims() {
  const token = getJwt();
  const claims = parseJwt(token);
  $("claims").textContent = claims ? JSON.stringify(claims, null, 2) : "(no/invalid JWT)";
}

function setLastResponse(obj) {
  $("lastResponse").textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

async function apiFetch(path, { method = "GET", body = undefined } = {}) {
  const base = getApiBaseUrl();
  if (!base) throw new Error("Missing API Base URL");
  const url = `${base}${path}`;

  const jwt = getJwt();
  const headers = new Headers();
  headers.set("accept", "application/json");
  if (jwt) headers.set("authorization", `Bearer ${jwt}`);

  let payload;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    // Likely CORS/network
    setLastResponse({ ok: false, error: "NETWORK_OR_CORS", message: String(e) });
    throw e;
  }

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  setLastResponse({
    request: { method, url },
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: parsed,
  });

  if (!res.ok) {
    const msg = (parsed && parsed.message) ? parsed.message : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

/* ---------- UI: Users ---------- */

let usersCache = [];

function normalizeGroupField(g) {
  if (!g) return [];
  if (Array.isArray(g)) return g.map(String).filter(Boolean);
  if (typeof g === "string") {
    const s = g.trim();
    if (!s) return [];
    if (s.startsWith("[") && s.endsWith("]")) {
      // handles ["A","B"] and [A] and [GodAdmin]
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      if (inner.includes('"')) {
        try {
          const arr = JSON.parse(s);
          return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [inner];
        } catch {
          return inner.split(",").map((x) => x.trim()).filter(Boolean);
        }
      }
      return inner.split(",").map((x) => x.trim()).filter(Boolean);
    }
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
    return [s];
  }
  return [String(g)];
}

function renderUsersTable() {
  const tbody = $("usersTbody");
  tbody.innerHTML = "";

  const q = ($("search").value || "").trim().toLowerCase();
  const fg = $("filterGroup").value;

  const filtered = usersCache.filter((u) => {
    const email = (u.email || "").toLowerCase();
    const username = (u.username || "").toLowerCase();
    const sub = (u.sub || "").toLowerCase();
    const groups = normalizeGroupField(u.groups);
    const groupsStr = groups.join(", ").toLowerCase();

    const matchesQ = !q || email.includes(q) || username.includes(q) || sub.includes(q) || groupsStr.includes(q);

    const matchesGroup =
      !fg
        ? true
        : (fg === "(none)")
          ? (groups.length === 0)
          : groups.includes(fg);

    return matchesQ && matchesGroup;
  });

  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="muted">No matching users.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const u of filtered) {
    const tr = document.createElement("tr");
    const groups = normalizeGroupField(u.groups);

    tr.innerHTML = `
      <td>${escapeHtml(u.email || "")}</td>
      <td class="mono">${escapeHtml(u.username || "")}</td>
      <td class="mono">${escapeHtml(u.sub || "")}</td>
      <td>${escapeHtml(groups.join(", ") || "(none)")}</td>
      <td>${escapeHtml(u.status || "")}</td>
    `;

    tr.addEventListener("click", () => {
      // Convenience: click row fills role email box
      if (u.email) $("roleEmail").value = u.email;
    });

    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refreshUsers() {
  // Expect your backend to return something like:
  // { users: [{ email, username, sub, groups, status }, ...] }
  // or just an array.
  const data = await apiFetch("/admin/users", { method: "GET" });

  if (Array.isArray(data)) usersCache = data;
  else if (data && Array.isArray(data.users)) usersCache = data.users;
  else usersCache = [];

  renderUsersTable();
}

async function createUser() {
  const email = ($("newEmail").value || "").trim();
  if (!email) throw new Error("Email required");

  const role = ($("newRole").value || "").trim();

  // Backend can choose to ignore "role" if not supported yet.
  // Suggest request shape:
  // { email, role? }
  await apiFetch("/admin/users", {
    method: "POST",
    body: role ? { email, role } : { email },
  });

  $("newEmail").value = "";
  await refreshUsers();
}

async function setRole() {
  const email = ($("roleEmail").value || "").trim();
  if (!email) throw new Error("Email required");

  const role = ($("roleValue").value || "").trim(); // "" means clear groups
  // Suggest request shape:
  // { email, role }   where role in ["PlatformAdmin","InternalOps","Seller",""]
  await apiFetch("/admin/users/role", {
    method: "PATCH",
    body: { email, role },
  });

  await refreshUsers();
}

async function callDebug() {
  await apiFetch("/admin/_debug", { method: "GET" });
}

/* ---------- init ---------- */

function bind() {
  $("btnSaveConfig").addEventListener("click", () => {
    saveConfig();
    setLastResponse({ ok: true, message: "Config saved." });
  });

  $("btnSaveJwt").addEventListener("click", () => {
    saveJwt();
    setLastResponse({ ok: true, message: "JWT saved." });
  });

  $("btnClearJwt").addEventListener("click", () => {
    clearJwt();
    setLastResponse({ ok: true, message: "JWT cleared." });
  });

  $("btnRefresh").addEventListener("click", async () => {
    try { await refreshUsers(); } catch (e) {}
  });

  $("btnCreateUser").addEventListener("click", async () => {
    try { await createUser(); } catch (e) {}
  });

  $("btnSetRole").addEventListener("click", async () => {
    try { await setRole(); } catch (e) {}
  });

  $("btnDebug").addEventListener("click", async () => {
    try { await callDebug(); } catch (e) {}
  });

  $("search").addEventListener("input", renderUsersTable);
  $("filterGroup").addEventListener("change", renderUsersTable);

  // Keep login link fresh if any config changes
  $("cognitoDomain").addEventListener("input", updateLoginLink);
  $("clientId").addEventListener("input", updateLoginLink);
  $("redirectUri").addEventListener("input", updateLoginLink);
}

(function main() {
  loadState();
  updateLoginLink();
  renderClaims();
  bind();

  // Auto-refresh once on load (best-effort)
  refreshUsers().catch(() => {});
})();
