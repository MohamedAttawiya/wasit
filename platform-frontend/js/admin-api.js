import { authHeader } from "./auth.js";

export const GROUPS = ["PlatformAdmin", "InternalOps", "Seller"];
export const USER_STATES = ["ACTIVE", "SUSPENDED", "DISABLED"];

// Infer API base from ../auth.json (served from the same origin bucket/CloudFront)
let _apiBasePromise = null;

async function getApiBase() {
  if (_apiBasePromise) return _apiBasePromise;

  _apiBasePromise = (async () => {
    // Try a couple of paths to be resilient to where this file sits
    const candidates = ["../auth.json", "/auth.json", "./auth.json"];

    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
        const cfg = await res.json();

        const apiBase = cfg?.apiBaseUrl;
        if (typeof apiBase !== "string" || !apiBase.trim()) {
          throw new Error(`auth.json missing apiBaseUrl at ${url}`);
        }

        return apiBase.replace(/\/+$/, ""); // trim trailing slash
      } catch (e) {
        lastErr = e;
      }
    }

    console.error("Could not load apiBaseUrl from auth.json.", lastErr);
    // Hard fail is usually better than silently calling a wrong API
    throw lastErr ?? new Error("Could not load apiBaseUrl from auth.json");
  })();

  return _apiBasePromise;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeBody(body, headers) {
  if (!body || typeof body !== "object") return body;
  headers.set("content-type", "application/json");
  return JSON.stringify(body);
}

function handleAuthStatus(status) {
  if (status === 401) {
    window.location.replace("/login");
    return true;
  }
  return false;
}

async function request(path, { method = "GET", body, headers: headerInit } = {}) {
  const headers = new Headers(headerInit || {});
  headers.set("accept", "application/json");

  const auth = authHeader();
  if (auth.Authorization) headers.set("authorization", auth.Authorization);

  const payload = normalizeBody(body, headers);

  const API_BASE = await getApiBase();

  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const data = parseJson(text);

  if (handleAuthStatus(res.status)) {
    throw new Error("Redirecting to login");
  }

  if (res.status === 403) {
    const err = new Error("Not authorized");
    err.status = 403;
    err.body = data;
    throw err;
  }

  if (!res.ok) {
    const err = new Error((data && data.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

export async function fetchUsers() {
  const data = await request("/admin/users");
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.users)) return data.users;
  return [];
}

export async function createUser(payload) {
  return request("/admin/users", { method: "POST", body: payload });
}

export async function updateUserGroups(email, set) {
  return request("/admin/users/groups", { method: "PATCH", body: { email, set } });
}

export async function updateUserState(email, state) {
  return request("/admin/users/state", { method: "PATCH", body: { email, state } });
}

export async function deleteUser(email) {
  return request("/admin/users", { method: "DELETE", body: { email } });
}
