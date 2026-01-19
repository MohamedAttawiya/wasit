import {
  getSession,
  readTokensFromHashAndPersist,
  renderShell,
} from "./auth.js";
import {
  GROUPS,
  USER_STATES,
  createUser,
  deleteUser,
  fetchUsers,
  updateUserGroups,
  updateUserState,
} from "./admin-api.js";

const GROUP_SET = new Set(GROUPS);

const state = {
  session: null,
  users: [],
  loadingUsers: false,
  listError: "",
  createBusy: false,
  createError: "",
  perUser: {}, // email -> { groupsBusy, stateBusy, deleteBusy, groupsError, stateError, deleteError }
};

const elements = {
  buckets: {},
  loading: null,
  listError: null,
  createForm: null,
  createError: null,
  createButton: null,
};

function normalizeGroups(raw) {
  if (!raw) return [];
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) arr = [];
    else if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || trimmed.includes("\"")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) arr = parsed;
        else arr = [trimmed];
      } catch {
        arr = trimmed.split(",").map((g) => g.trim());
      }
    } else if (trimmed.includes(",")) arr = trimmed.split(",").map((g) => g.trim());
    else arr = [trimmed];
  } else {
    arr = [raw];
  }

  return arr
    .map((g) => (g == null ? "" : g.toString().trim()))
    .filter(Boolean)
    .filter((g) => GROUP_SET.has(g));
}

function normalizeState(raw) {
  const candidate = raw ? raw.toString().toUpperCase() : "";
  if (USER_STATES.includes(candidate)) return candidate;
  return "ACTIVE";
}

function normalizeUser(user) {
  return {
    email: user.email || "",
    name: user.name || "",
    groups: normalizeGroups(user.groups || user.user_groups || user.userGroups),
    state: normalizeState(user.state || user.user_state || user.status),
    enabled: typeof user.enabled === "boolean"
      ? user.enabled
      : (typeof user.Enabled === "boolean" ? user.Enabled : null),
    raw: user,
  };
}

function bucketize(users) {
  const buckets = {
    PlatformAdmin: [],
    InternalOps: [],
    Seller: [],
  };

  for (const u of users) {
    let placed = false;
    for (const group of GROUPS) {
      if (u.groups.includes(group)) {
        buckets[group].push(u);
        placed = true;
      }
    }
    if (!placed) buckets.Seller.push(u); // ensure user is visible even if no groups yet
  }

  return buckets;
}

function setListError(msg) {
  state.listError = msg || "";
  if (elements.listError) {
    elements.listError.textContent = state.listError;
    elements.listError.style.display = msg ? "block" : "none";
  }
}

function setLoading(isLoading) {
  state.loadingUsers = isLoading;
  if (elements.loading) {
    elements.loading.style.display = isLoading ? "block" : "none";
  }
}

function ensureUserTracker(email) {
  if (!state.perUser[email]) {
    state.perUser[email] = {
      groupsBusy: false,
      stateBusy: false,
      deleteBusy: false,
      groupsError: "",
      stateError: "",
      deleteError: "",
    };
  }
  return state.perUser[email];
}

function formatError(err) {
  if (!err) return "Something went wrong.";
  if (err.status === 403) return "Not authorized";
  if (err.status === 401) return "Please login";
  return err.message || "Something went wrong.";
}

function updateUserLocal(user) {
  const idx = state.users.findIndex((u) => u.email === user.email);
  if (idx >= 0) state.users[idx] = normalizeUser(user);
  else state.users.push(normalizeUser(user));
}

async function loadUsers() {
  setLoading(true);
  setListError("");
  try {
    const list = await fetchUsers();
    state.users = list.map(normalizeUser);
    renderBuckets();
  } catch (err) {
    setListError(formatError(err));
  } finally {
    setLoading(false);
  }
}

function getSelectedValues(selectEl) {
  return Array.from(selectEl.selectedOptions || []).map((o) => o.value).filter(Boolean);
}

function isSelf(email) {
  const me = (state.session?.email || "").toLowerCase();
  return me && email && me === email.toLowerCase();
}

async function handleGroupsSave(user, selectEl) {
  const tracker = ensureUserTracker(user.email);
  tracker.groupsError = "";

  const selected = getSelectedValues(selectEl);
  if (isSelf(user.email) && user.groups.includes("PlatformAdmin") && !selected.includes("PlatformAdmin")) {
    tracker.groupsError = "You cannot remove PlatformAdmin from your own user.";
    renderBuckets();
    return;
  }

  tracker.groupsBusy = true;
  renderBuckets();
  try {
    const res = await updateUserGroups(user.email, selected);
    if (res?.user) updateUserLocal(res.user);
    await loadUsers();
  } catch (err) {
    tracker.groupsError = formatError(err);
    renderBuckets();
  } finally {
    tracker.groupsBusy = false;
    renderBuckets();
  }
}

async function handleStateSave(user, selectEl) {
  const tracker = ensureUserTracker(user.email);
  tracker.stateError = "";

  const newState = selectEl.value;
  tracker.stateBusy = true;
  renderBuckets();
  try {
    const res = await updateUserState(user.email, newState);
    if (res?.user) updateUserLocal(res.user);
    await loadUsers();
  } catch (err) {
    tracker.stateError = formatError(err);
    renderBuckets();
  } finally {
    tracker.stateBusy = false;
    renderBuckets();
  }
}

async function handleDelete(user) {
  if (isSelf(user.email)) return;
  if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;

  const tracker = ensureUserTracker(user.email);
  tracker.deleteError = "";
  tracker.deleteBusy = true;
  renderBuckets();
  try {
    await deleteUser(user.email);
    state.users = state.users.filter((u) => u.email !== user.email);
    renderBuckets();
  } catch (err) {
    tracker.deleteError = formatError(err);
    renderBuckets();
  } finally {
    tracker.deleteBusy = false;
    renderBuckets();
  }
}

function renderUserRow(user) {
  const tracker = ensureUserTracker(user.email);

  const row = document.createElement("div");
  row.className = "user-row";
  if (tracker.groupsBusy || tracker.stateBusy || tracker.deleteBusy) row.classList.add("user-row-busy");

  const main = document.createElement("div");
  main.className = "user-main";

  const left = document.createElement("div");
  left.className = "user-info";

  const email = document.createElement("div");
  email.className = "user-email";
  email.textContent = user.email || "(no email)";
  left.appendChild(email);

  const meta = document.createElement("div");
  meta.className = "user-meta";

  const statePill = document.createElement("span");
  statePill.className = "pill";
  statePill.textContent = `State: ${user.state || "Unknown"}`;
  meta.appendChild(statePill);

  const enabledPill = document.createElement("span");
  enabledPill.className = "pill pill-muted";
  let enabledLabel = "Status: Unknown";
  if (user.enabled === true) enabledLabel = "Status: Enabled";
  else if (user.enabled === false) enabledLabel = "Status: Disabled";
  enabledPill.textContent = enabledLabel;
  meta.appendChild(enabledPill);

  left.appendChild(meta);
  main.appendChild(left);

  const right = document.createElement("div");
  right.className = "user-actions";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn";
  deleteBtn.textContent = "Delete user";
  deleteBtn.disabled = tracker.deleteBusy || isSelf(user.email);
  deleteBtn.addEventListener("click", () => handleDelete(user));
  right.appendChild(deleteBtn);

  main.appendChild(right);
  row.appendChild(main);

  const groupsField = document.createElement("div");
  groupsField.className = "field";
  const groupsLabel = document.createElement("span");
  groupsLabel.textContent = "Groups";
  groupsField.appendChild(groupsLabel);

  const groupsSelect = document.createElement("select");
  groupsSelect.multiple = true;
  groupsSelect.size = GROUPS.length;
  groupsSelect.disabled = tracker.groupsBusy;

  GROUPS.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    if (user.groups.includes(g)) opt.selected = true;
    if (isSelf(user.email) && g === "PlatformAdmin") {
      opt.selected = true;
      opt.disabled = true;
    }
    groupsSelect.appendChild(opt);
  });
  groupsField.appendChild(groupsSelect);

  const groupsActions = document.createElement("div");
  groupsActions.className = "row";
  const groupsSave = document.createElement("button");
  groupsSave.type = "button";
  groupsSave.className = "btn btn-primary";
  groupsSave.textContent = tracker.groupsBusy ? "Saving..." : "Save groups";
  groupsSave.disabled = tracker.groupsBusy;
  groupsSave.addEventListener("click", () => handleGroupsSave(user, groupsSelect));
  groupsActions.appendChild(groupsSave);
  groupsField.appendChild(groupsActions);
  row.appendChild(groupsField);

  const stateField = document.createElement("div");
  stateField.className = "field";
  const stateLabel = document.createElement("span");
  stateLabel.textContent = "User state";
  stateField.appendChild(stateLabel);

  const stateSelect = document.createElement("select");
  USER_STATES.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (user.state === s) opt.selected = true;
    stateSelect.appendChild(opt);
  });
  stateSelect.disabled = tracker.stateBusy;
  stateField.appendChild(stateSelect);

  const stateActions = document.createElement("div");
  stateActions.className = "row";
  const stateSave = document.createElement("button");
  stateSave.type = "button";
  stateSave.className = "btn";
  stateSave.textContent = tracker.stateBusy ? "Saving..." : "Update state";
  stateSave.disabled = tracker.stateBusy;
  stateSave.addEventListener("click", () => handleStateSave(user, stateSelect));
  stateActions.appendChild(stateSave);
  stateField.appendChild(stateActions);
  row.appendChild(stateField);

  if (tracker.groupsError || tracker.stateError || tracker.deleteError) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = tracker.groupsError || tracker.stateError || tracker.deleteError;
    row.appendChild(err);
  }

  return row;
}

function renderBuckets() {
  const buckets = bucketize(state.users);
  for (const group of GROUPS) {
    const body = elements.buckets[group];
    if (!body) continue;
    body.innerHTML = "";
    const items = buckets[group];
    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No users yet.";
      body.appendChild(empty);
      continue;
    }
    for (const u of items) {
      body.appendChild(renderUserRow(u));
    }
  }
}

async function handleCreateUser(e) {
  e.preventDefault();
  if (state.createBusy) return;
  state.createError = "";
  elements.createError.style.display = "none";

  const formData = new FormData(elements.createForm);
  const email = (formData.get("email") || "").toString().trim();
  const name = (formData.get("name") || "").toString().trim();
  const selectedGroups = getSelectedValues(elements.createForm.querySelector("[name='groups']"));
  const stateValue = (formData.get("state") || "ACTIVE").toString().trim() || "ACTIVE";

  if (!email) {
    state.createError = "Email is required.";
    elements.createError.textContent = state.createError;
    elements.createError.style.display = "block";
    return;
  }

  state.createBusy = true;
  elements.createButton.textContent = "Creating...";
  elements.createButton.disabled = true;

  try {
    const payload = { email };
    if (name) payload.name = name;
    if (selectedGroups.length > 0) payload.groups = selectedGroups;
    if (stateValue) payload.state = stateValue;

    await createUser(payload);
    elements.createForm.reset();
    await loadUsers();
  } catch (err) {
    state.createError = formatError(err);
    elements.createError.textContent = state.createError;
    elements.createError.style.display = "block";
  } finally {
    state.createBusy = false;
    elements.createButton.textContent = "Create user";
    elements.createButton.disabled = false;
  }
}

function buildBuckets(main) {
  const grid = document.createElement("div");
  grid.className = "grid buckets";
  GROUPS.forEach((group) => {
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "section-head";

    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = group;

    const count = document.createElement("span");
    count.className = "pill pill-muted";
    count.textContent = "Group bucket";

    head.appendChild(title);
    head.appendChild(count);

    const body = document.createElement("div");
    body.className = "bucket-body";
    elements.buckets[group] = body;

    card.appendChild(head);
    card.appendChild(body);
    grid.appendChild(card);
  });
  main.appendChild(grid);
}

function buildCreatePanel(main) {
  const card = document.createElement("div");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "section-head";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Create user";

  const warning = document.createElement("div");
  warning.className = "muted";
  warning.textContent = "Changes apply immediately.";

  head.appendChild(title);
  head.appendChild(warning);
  card.appendChild(head);

  const form = document.createElement("form");
  form.className = "form-grid";
  elements.createForm = form;

  const emailField = document.createElement("label");
  emailField.className = "field";
  emailField.innerHTML = `<span>Email *</span><input type="email" name="email" required placeholder="user@example.com" />`;

  const nameField = document.createElement("label");
  nameField.className = "field";
  nameField.innerHTML = `<span>Name (optional)</span><input type="text" name="name" placeholder="Display name" />`;

  const groupsField = document.createElement("label");
  groupsField.className = "field";
  const groupLabel = document.createElement("span");
  groupLabel.textContent = "Groups (multi-select)";
  const groupsSelect = document.createElement("select");
  groupsSelect.name = "groups";
  groupsSelect.multiple = true;
  groupsSelect.size = GROUPS.length;
  GROUPS.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    groupsSelect.appendChild(opt);
  });
  groupsField.appendChild(groupLabel);
  groupsField.appendChild(groupsSelect);

  const stateField = document.createElement("label");
  stateField.className = "field";
  const stateLabel = document.createElement("span");
  stateLabel.textContent = "Initial state";
  const stateSelect = document.createElement("select");
  stateSelect.name = "state";
  USER_STATES.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === "ACTIVE") opt.selected = true;
    stateSelect.appendChild(opt);
  });
  stateField.appendChild(stateLabel);
  stateField.appendChild(stateSelect);

  const actions = document.createElement("div");
  actions.className = "row";
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.className = "btn btn-primary";
  btn.textContent = "Create user";
  elements.createButton = btn;
  actions.appendChild(btn);

  form.appendChild(emailField);
  form.appendChild(nameField);
  form.appendChild(groupsField);
  form.appendChild(stateField);
  form.appendChild(actions);

  const error = document.createElement("div");
  error.className = "error";
  error.style.display = "none";
  elements.createError = error;

  form.addEventListener("submit", handleCreateUser);

  card.appendChild(form);
  card.appendChild(error);
  main.appendChild(card);
}

function buildUsersSection(main) {
  const section = document.createElement("section");
  section.className = "section";

  const head = document.createElement("div");
  head.className = "section-head";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Users";

  const actions = document.createElement("div");
  actions.className = "top-actions";

  const reload = document.createElement("button");
  reload.className = "btn";
  reload.textContent = "Refresh";
  reload.addEventListener("click", loadUsers);
  actions.appendChild(reload);

  head.appendChild(title);
  head.appendChild(actions);

  const loading = document.createElement("div");
  loading.className = "muted";
  loading.textContent = "Loading users...";
  loading.style.display = "none";
  elements.loading = loading;

  const listError = document.createElement("div");
  listError.className = "error";
  listError.style.display = "none";
  elements.listError = listError;

  section.appendChild(head);
  section.appendChild(loading);
  section.appendChild(listError);
  main.appendChild(section);

  buildCreatePanel(main);
  buildBuckets(main);
}

function init() {
  readTokensFromHashAndPersist();
  const session = getSession();
  state.session = session;

  if (!session.loggedIn) {
    window.location.replace("/login");
    return;
  }

  if (!session.groups.includes("PlatformAdmin")) {
    window.location.replace("/unauthorized");
    return;
  }

  const { main } = renderShell({
    session,
    heading: "Platform Admin Control Plane",
    subheading: "Manage users and groups. Changes apply immediately.",
  });

  buildUsersSection(main);
  loadUsers();
}

init();
