// auth.js (updated): build login/logout URLs from ../auth.json

const HOME_PATH = "index.html";

const STORAGE_KEYS = {
  idToken: "wasit.auth.id_token",
  accessToken: "wasit.auth.access_token",
  expiresAt: "wasit.auth.expires_at",
};

const RECOGNIZED_GROUPS = ["PlatformAdmin", "InternalOps", "Seller"];

let _authCfgPromise = null;

async function loadAuthConfig() {
  if (_authCfgPromise) return _authCfgPromise;

  _authCfgPromise = (async () => {
    // Be resilient to where this file is served from
    const candidates = ["../auth.json", "/auth.json", "./auth.json"];

    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
        const cfg = await res.json();

        const clientID = cfg?.clientID;
        const cognitoDomain = cfg?.cognitoDomain;

        // apiBaseUrl/userPoolId are still useful elsewhere, but not required to build login/logout
        if (typeof clientID !== "string" || !clientID.trim()) {
          throw new Error(`auth.json missing clientID at ${url}`);
        }
        if (typeof cognitoDomain !== "string" || !cognitoDomain.trim()) {
          throw new Error(`auth.json missing cognitoDomain at ${url}`);
        }

        return {
          clientID: clientID.trim(),
          cognitoDomain: cognitoDomain.trim(), // host only, no https
          apiBaseUrl: (cfg?.apiBaseUrl || "").trim(),
          userPoolId: (cfg?.userPoolId || "").trim(),
          issuer: (cfg?.issuer || "").trim(),
        };
      } catch (e) {
        lastErr = e;
      }
    }

    console.error("Could not load auth config from auth.json.", lastErr);
    throw lastErr ?? new Error("Could not load auth.json");
  })();

  return _authCfgPromise;
}

function currentRedirectUri() {
  // Cognito expects an exact match to allowed callback URLs.
  // Force the redirect to the app home (root /index.html), regardless of current page path.
  const u = new URL(window.location.origin);
  u.pathname = `/${HOME_PATH}`; // "/index.html"
  return u.toString();
}


function buildHostedUiUrl({ cognitoDomain, clientID, redirectUri, kind }) {
  const base = `https://${cognitoDomain}`;

  if (kind === "login") {
    const url = new URL("/login", base);
    url.searchParams.set("client_id", clientID);
    url.searchParams.set("response_type", "token"); // keep as-is to match your current implicit flow
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  }

  if (kind === "logout") {
    const url = new URL("/logout", base);
    url.searchParams.set("client_id", clientID);
    url.searchParams.set("logout_uri", redirectUri);
    return url.toString();
  }

  throw new Error(`Unknown kind: ${kind}`);
}

function base64UrlDecode(input) {
  try {
    const padded = input.padEnd(Math.ceil(input.length / 4) * 4, "=");
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(normalized);
  } catch {
    return null;
  }
}

function decodeJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = base64UrlDecode(parts[1]);
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function normalizeGroups(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      trimmed.startsWith("{") ||
      trimmed.startsWith('"')
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
        if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
      } catch {
        /* fall through */
      }
    }

    if (trimmed.includes(",")) return trimmed.split(",").map((g) => g.trim()).filter(Boolean);
    return [trimmed];
  }

  return [String(raw)];
}

function pickPrimaryRole(groups) {
  for (const role of RECOGNIZED_GROUPS) {
    if (groups.includes(role)) return role;
  }
  return null;
}

function persistTokens({ idToken, accessToken, expiresAt }) {
  if (idToken) localStorage.setItem(STORAGE_KEYS.idToken, idToken);
  if (accessToken) localStorage.setItem(STORAGE_KEYS.accessToken, accessToken);
  if (expiresAt) localStorage.setItem(STORAGE_KEYS.expiresAt, String(expiresAt));
}

function clearTokens() {
  localStorage.removeItem(STORAGE_KEYS.idToken);
  localStorage.removeItem(STORAGE_KEYS.accessToken);
  localStorage.removeItem(STORAGE_KEYS.expiresAt);
}

function redirectHomeWithMessage(msg) {
  const url = new URL(HOME_PATH, window.location.href);
  if (msg) url.searchParams.set("msg", msg);
  window.location.replace(url.toString());
}

export function readTokensFromHashAndPersist() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const idToken = params.get("id_token");
  const accessToken = params.get("access_token");
  const expiresInRaw = params.get("expires_in");

  if (!idToken && !accessToken) return null;

  const expiresIn = expiresInRaw ? parseInt(expiresInRaw, 10) : 0;
  let expiresAt = 0;
  if (!Number.isNaN(expiresIn) && expiresIn > 0) {
    expiresAt = Date.now() + expiresIn * 1000;
  }

  if (!expiresAt && idToken) {
    const claims = decodeJwt(idToken);
    if (claims && claims.exp) expiresAt = claims.exp * 1000;
  }

  persistTokens({ idToken, accessToken, expiresAt });
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return { idToken, accessToken, expiresAt };
}

export function getSession() {
  const idToken = localStorage.getItem(STORAGE_KEYS.idToken) || "";
  const accessToken = localStorage.getItem(STORAGE_KEYS.accessToken) || "";
  const expiresAtRaw = localStorage.getItem(STORAGE_KEYS.expiresAt);
  const expiresAt = expiresAtRaw ? parseInt(expiresAtRaw, 10) : 0;

  if (!idToken || !expiresAt || Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    if (expiresAt && expiresAt <= Date.now()) clearTokens();
    return {
      loggedIn: false,
      email: "",
      groups: [],
      role: null,
      idToken: "",
      accessToken: "",
      expiresAt: 0,
    };
  }

  const claims = decodeJwt(idToken) || {};
  const email = claims.email || claims.username || "";
  const groups = normalizeGroups(claims["cognito:groups"]);
  const primaryRole = pickPrimaryRole(groups);

  return {
    loggedIn: true,
    email,
    groups,
    role: primaryRole,
    idToken,
    accessToken,
    expiresAt,
  };
}

export function authHeader() {
  const session = getSession();
  if (!session.loggedIn || !session.idToken) return {};
  return { Authorization: `Bearer ${session.idToken}` };
}

export async function loginUrl() {
  const cfg = await loadAuthConfig();
  // Uses the same redirect uri as current page (must be in callbackUrls)
  const redirectUri = currentRedirectUri();
  return buildHostedUiUrl({
    cognitoDomain: cfg.cognitoDomain,
    clientID: cfg.clientID,
    redirectUri,
    kind: "login",
  });
}

export async function logoutUrl() {
  const cfg = await loadAuthConfig();
  const redirectUri = currentRedirectUri();
  return buildHostedUiUrl({
    cognitoDomain: cfg.cognitoDomain,
    clientID: cfg.clientID,
    redirectUri,
    kind: "logout",
  });
}

export async function logout() {
  clearTokens();
  window.location.replace(await logoutUrl());
}

export function requireLogin() {
  const session = getSession();
  if (!session.loggedIn) {
    redirectHomeWithMessage("Please login first");
    return { redirected: true, session };
  }
  return { redirected: false, session };
}

// ---- unchanged below (renderForbidden / requireGroup / renderShell) ----

export function renderForbidden(requiredGroup, session) {
  const shell = renderShell({
    session,
    heading: "403 Forbidden",
    subheading: "You are not allowed to view this page.",
  });

  const card = document.createElement("div");
  card.className = "card";

  const title = document.createElement("h2");
  title.textContent = "Access denied";
  card.appendChild(title);

  const info = document.createElement("p");
  info.textContent = `This page requires the ${requiredGroup} role.`;
  card.appendChild(info);

  const list = document.createElement("p");
  list.textContent =
    session && session.groups.length > 0
      ? `Your groups: ${session.groups.join(", ")}`
      : "No groups detected on your session.";
  card.appendChild(list);

  const action = document.createElement("a");
  action.href = HOME_PATH;
  action.className = "btn";
  action.textContent = "Back to Home";
  card.appendChild(action);

  shell.main.innerHTML = "";
  shell.main.appendChild(card);
}

export function requireGroup(requiredGroup) {
  const loginState = requireLogin();
  if (loginState.redirected)
    return { allowed: false, session: loginState.session, redirected: true };

  const session = loginState.session;
  if (!session.groups.includes(requiredGroup)) {
    renderForbidden(requiredGroup, session);
    return { allowed: false, session, redirected: false };
  }

  return { allowed: true, session, redirected: false };
}

export function renderShell({ session, heading, subheading, message }) {
  const root = document.getElementById("app") || document.body;
  root.innerHTML = "";

  const shell = document.createElement("div");
  shell.className = "shell";

  const topbar = document.createElement("header");
  topbar.className = "topbar";

  const left = document.createElement("div");
  left.className = "top-left";

  const logo = document.createElement("div");
  logo.className = "logo";
  logo.textContent = "W";
  left.appendChild(logo);

  const meta = document.createElement("div");
  meta.className = "top-meta";

  const appName = document.createElement("div");
  appName.className = "app-name";
  appName.textContent = "Wasit Admin";
  meta.appendChild(appName);

  const email = document.createElement("div");
  email.className = "user-email";
  email.textContent = session.loggedIn ? session.email || "Signed in" : "Not logged in";
  meta.appendChild(email);

  left.appendChild(meta);

  const right = document.createElement("div");
  right.className = "top-actions";

  if (session.loggedIn) {
    const roleTag = document.createElement("span");
    roleTag.className = "role-chip";
    roleTag.textContent = session.role || (session.groups[0] || "Member");
    right.appendChild(roleTag);

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "btn btn-ghost";
    logoutBtn.textContent = "Logout";
    logoutBtn.addEventListener("click", () => {
      // async handler; we do not block UI thread
      logout().catch((e) => console.error("Logout failed", e));
    });
    right.appendChild(logoutBtn);
  } else {
    const loginBtn = document.createElement("a");
    loginBtn.className = "btn btn-primary";
    loginBtn.href = "#"; // set asynchronously
    loginBtn.textContent = "Login";
    loginBtn.rel = "noreferrer";

    // set href async (no top-level await needed)
    loginUrl()
      .then((u) => (loginBtn.href = u))
      .catch((e) => {
        console.error("Failed to build login URL", e);
        // fall back to a safe message
        loginBtn.href = HOME_PATH;
      });

    right.appendChild(loginBtn);
  }

  topbar.appendChild(left);
  topbar.appendChild(right);

  const hero = document.createElement("section");
  hero.className = "hero";

  const heroTitle = document.createElement("h1");
  heroTitle.textContent = heading || "Admin Portal";
  hero.appendChild(heroTitle);

  if (subheading) {
    const heroSub = document.createElement("p");
    heroSub.className = "hero-sub";
    heroSub.textContent = subheading;
    hero.appendChild(heroSub);
  }

  const main = document.createElement("main");
  main.className = "page";

  if (message) {
    const flash = document.createElement("div");
    flash.className = "flash";
    flash.textContent = message;
    main.appendChild(flash);
  }

  shell.appendChild(topbar);
  shell.appendChild(hero);
  shell.appendChild(main);
  root.appendChild(shell);

  return { shell, main };
}
