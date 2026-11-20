const fileInput = document.getElementById("fileInput");
const profileList = document.getElementById("profileList");
const statusBadge = document.getElementById("statusBadge");
const errorBox = document.getElementById("errorBox");
const bypassInput = document.getElementById("bypassInput");
const portInput = document.getElementById("portInput");
const tabNative = document.getElementById("tabNative");
const tabProton = document.getElementById("tabProton");
const panelNative = document.getElementById("panelNative");
const panelProton = document.getElementById("panelProton");
const protonUser = document.getElementById("protonUser");
const protonPass = document.getElementById("protonPass");
const protonFilter = document.getElementById("protonFilter");
const refreshProton = document.getElementById("refreshProton");
const protonCustomDomain = document.getElementById("protonCustomDomain");
const addProtonDomain = document.getElementById("addProtonDomain");
const protonList = document.getElementById("protonList");

let profiles = [];
let protonServers = [];
let vpnState = { status: "disconnected", mode: null, activeProfileId: null, port: null, error: null };

function parseEndpoint(config, type) {
  if (type === "wg") {
    const m = config.match(/^\s*Endpoint\s*=\s*(.+)$/mi);
    return m ? m[1].trim() : "WireGuard";
  }
  const m = config.match(/^\s*remote\s+([^\s]+)\s+(\d+)/mi);
  return m ? `${m[1]}:${m[2]}` : "OpenVPN";
}

function renderStatus() {
  statusBadge.className = `badge ${vpnState.status}`;
  if (vpnState.status === "connected" && vpnState.port) {
    statusBadge.textContent = `Connected :${vpnState.port}`;
  } else {
    statusBadge.textContent = vpnState.status.charAt(0).toUpperCase() + vpnState.status.slice(1);
  }
  if (vpnState.error) {
    errorBox.textContent = vpnState.error;
    errorBox.classList.remove("hidden");
  } else {
    errorBox.classList.add("hidden");
  }
}

function renderProfiles() {
  profileList.innerHTML = "";
  if (profiles.length === 0) {
    const empty = document.createElement("li");
    empty.className = "profile-meta";
    empty.textContent = "No profiles imported yet.";
    profileList.appendChild(empty);
    return;
  }

  for (const p of profiles) {
    const li = document.createElement("li");
    li.className = "profile-item";

    const info = document.createElement("div");
    info.className = "profile-info";

    const name = document.createElement("div");
    name.className = "profile-name";
    name.textContent = p.name;
    name.title = "Click to rename";
    name.onclick = () => {
      const input = document.createElement("input");
      input.className = "profile-name-input";
      input.value = p.name;
      const save = async () => {
        const val = input.value.trim();
        if (val) p.name = val;
        await chrome.storage.local.set({ profiles });
        renderProfiles();
      };
      input.onblur = save;
      input.onkeydown = (ev) => {
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") renderProfiles();
      };
      name.replaceWith(input);
      input.focus();
      input.select();
    };

    const meta = document.createElement("div");
    meta.className = "profile-meta";
    meta.textContent = `${p.type.toUpperCase()} • ${p.endpoint}`;

    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "profile-actions";

    const isActive = vpnState.activeProfileId === p.id &&
      (vpnState.status === "connected" || vpnState.status === "connecting");

    const toggleBtn = document.createElement("button");
    toggleBtn.className = isActive ? "btn-disconnect" : "btn-connect";
    toggleBtn.textContent = isActive ? "Disconnect" : "Connect";
    toggleBtn.onclick = () => {
      if (isActive) {
        chrome.runtime.sendMessage({ type: "disconnect" });
      } else {
        chrome.runtime.sendMessage({ type: "connect", profile: p });
      }
    };

    const delBtn = document.createElement("button");
    delBtn.className = "btn-delete";
    delBtn.textContent = "×";
    delBtn.title = "Delete";
    delBtn.onclick = async () => {
      if (isActive) chrome.runtime.sendMessage({ type: "disconnect" });
      profiles = profiles.filter((x) => x.id !== p.id);
      await chrome.storage.local.set({ profiles });
      renderProfiles();
    };

    actions.append(toggleBtn, delBtn);
    li.append(info, actions);
    profileList.appendChild(li);
  }
}

fileInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const text = await file.text();
    const ext = file.name.toLowerCase().endsWith(".ovpn") ? "ovpn" : "wg";
    profiles.push({
      id: crypto.randomUUID(),
      name: file.name.replace(/\.(conf|ovpn)$/i, ""),
      type: ext,
      endpoint: parseEndpoint(text, ext),
      config: text
    });
  }
  await chrome.storage.local.set({ profiles });
  fileInput.value = "";
  renderProfiles();
});

portInput.addEventListener("change", () => {
  const val = parseInt(portInput.value, 10);
  const localPort = Number.isFinite(val) && val >= 0 && val <= 65535 ? val : 3322;
  portInput.value = localPort;
  chrome.storage.local.set({ localPort });
});

bypassInput.addEventListener("change", () => {
  const list = bypassInput.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  chrome.storage.local.set({ bypassList: list });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "state") {
    vpnState = msg.state;
    renderStatus();
    renderProfiles();
    renderProtonServers();
  }
});

function switchTab(tab) {
  const isProton = tab === "proton";
  tabNative.classList.toggle("active", !isProton);
  tabProton.classList.toggle("active", isProton);
  panelNative.classList.toggle("hidden", isProton);
  panelProton.classList.toggle("hidden", !isProton);
}

tabNative.onclick = () => switchTab("native");
tabProton.onclick = () => switchTab("proton");

function saveProtonCreds() {
  chrome.storage.local.set({
    protonUser: protonUser.value.trim(),
    protonPass: protonPass.value
  });
}

protonUser.addEventListener("change", saveProtonCreds);
protonPass.addEventListener("change", saveProtonCreds);
protonFilter.addEventListener("input", renderProtonServers);

function renderProtonServers() {
  protonList.innerHTML = "";
  const q = protonFilter.value.trim().toLowerCase();
  const filtered = protonServers
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.country.toLowerCase().includes(q))
    .slice(0, 60);

  if (filtered.length === 0) {
    const empty = document.createElement("li");
    empty.className = "profile-meta";
    empty.textContent = protonServers.length ? "No matching servers." : "Click Refresh to load servers.";
    protonList.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const li = document.createElement("li");
    li.className = "profile-item";

    const info = document.createElement("div");
    info.className = "profile-info";

    const name = document.createElement("div");
    name.className = "profile-name";
    name.textContent = s.name;

    const meta = document.createElement("div");
    meta.className = "profile-meta";
    meta.textContent = `${s.country} • Load ${s.load}%`;

    info.append(name, meta);

    const isActive = vpnState.mode === "proton" && vpnState.activeProfileId === s.id && vpnState.status === "connected";
    const btn = document.createElement("button");
    btn.className = isActive ? "btn-disconnect" : "btn-connect";
    btn.textContent = isActive ? "Disconnect" : "Connect";
    btn.onclick = () => {
      if (isActive) {
        chrome.runtime.sendMessage({ type: "disconnect" });
      } else {
        chrome.runtime.sendMessage({
          type: "connectProton",
          server: s,
          username: protonUser.value.trim(),
          password: protonPass.value
        });
      }
    };

    li.append(info, btn);
    protonList.appendChild(li);
  }
}

addProtonDomain.onclick = async () => {
  const domain = protonCustomDomain.value.trim();
  if (!domain) return;
  const name = domain.split(".")[0].toUpperCase();
  protonServers.unshift({
    id: crypto.randomUUID(),
    name,
    country: name.slice(0, 2),
    load: 0,
    tier: 0,
    domain
  });
  await chrome.storage.local.set({ protonServers });
  protonCustomDomain.value = "";
  renderProtonServers();
};

refreshProton.onclick = async () => {
  refreshProton.disabled = true;
  refreshProton.textContent = "...";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "fetchProtonServers" });
    if (!resp || !resp.ok) throw new Error(resp?.error || "Fetch failed");
    const json = resp.data;
    protonServers = (json.LogicalServers || [])
      .filter((s) => s.Status === 1 && s.Servers && s.Servers.length > 0)
      .map((s) => ({
        id: s.ID,
        name: s.Name,
        country: s.ExitCountry,
        load: s.Load,
        tier: s.Tier,
        domain: s.Servers[0].Domain
      }))
      .sort((a, b) => a.tier - b.tier || a.load - b.load);
    await chrome.storage.local.set({ protonServers });
    renderProtonServers();
  } catch (e) {
    errorBox.textContent = `Fetch error: ${e.message}`;
    errorBox.classList.remove("hidden");
  } finally {
    refreshProton.disabled = false;
    refreshProton.textContent = "Refresh";
  }
};

async function init() {
  const data = await chrome.storage.local.get([
    "profiles",
    "bypassList",
    "localPort",
    "protonUser",
    "protonPass",
    "protonServers"
  ]);
  profiles = data.profiles || [];
  protonServers = data.protonServers && data.protonServers.length ? data.protonServers : [
    { id: "nl-156", name: "NL-FREE#156", country: "NL", load: 0, tier: 0, domain: "nl-free-156.protonvpn.net" },
    { id: "no-4", name: "NO-FREE#4", country: "NO", load: 0, tier: 0, domain: "no-free-4.protonvpn.net" },
    { id: "us-1", name: "US-FREE#1", country: "US", load: 0, tier: 0, domain: "us-free-1.protonvpn.net" },
    { id: "jp-1", name: "JP-FREE#1", country: "JP", load: 0, tier: 0, domain: "jp-free-1.protonvpn.net" }
  ];
  protonUser.value = data.protonUser || "";
  protonPass.value = data.protonPass || "";
  portInput.value = data.localPort ?? 3322;
  bypassInput.value = (data.bypassList || ["localhost", "127.0.0.1", "*.local"]).join(", ");
  chrome.runtime.sendMessage({ type: "getState" }, (s) => {
    if (s) vpnState = s;
    if (vpnState.mode === "proton") switchTab("proton");
    renderStatus();
    renderProfiles();
    renderProtonServers();
  });
}

init();
