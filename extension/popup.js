const fileInput = document.getElementById("fileInput");
const profileList = document.getElementById("profileList");
const statusBadge = document.getElementById("statusBadge");
const errorBox = document.getElementById("errorBox");
const bypassInput = document.getElementById("bypassInput");
const portInput = document.getElementById("portInput");
const ovpnUser = document.getElementById("ovpnUser");
const ovpnPass = document.getElementById("ovpnPass");
const viaTor = document.getElementById("viaTor");
const killswitch = document.getElementById("killswitch");

let profiles = [];
let vpnState = { status: "disconnected", activeProfileId: null, port: null, error: null };

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

ovpnUser.addEventListener("change", () => {
  chrome.storage.local.set({ ovpnUser: ovpnUser.value.trim() });
});

ovpnPass.addEventListener("change", () => {
  chrome.storage.local.set({ ovpnPass: ovpnPass.value });
});

viaTor.addEventListener("change", () => {
  chrome.storage.local.set({ viaTor: viaTor.checked });
});

killswitch.addEventListener("change", async () => {
  await chrome.storage.local.set({ killswitch: killswitch.checked });
  chrome.runtime.sendMessage({ type: "updateKillswitch", enabled: killswitch.checked });
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
  }
});

async function init() {
  const data = await chrome.storage.local.get(["profiles", "bypassList", "localPort", "ovpnUser", "ovpnPass", "protonUser", "protonPass", "viaTor", "killswitch"]);
  profiles = data.profiles || [];
  portInput.value = data.localPort ?? 3322;
  ovpnUser.value = data.ovpnUser ?? data.protonUser ?? "";
  ovpnPass.value = data.ovpnPass ?? data.protonPass ?? "";
  viaTor.checked = Boolean(data.viaTor);
  killswitch.checked = Boolean(data.killswitch);
  bypassInput.value = (data.bypassList || ["localhost", "127.0.0.1", "*.local"]).join(", ");
  chrome.runtime.sendMessage({ type: "getState" }, (s) => {
    if (s) vpnState = s;
    renderStatus();
    renderProfiles();
  });
}

const exportBackupBtn = document.getElementById("exportBackupBtn");
const importBackupInput = document.getElementById("importBackupInput");

exportBackupBtn.addEventListener("click", async () => {
  const allData = await chrome.storage.local.get(null);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: allData
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wg-ovpn-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

importBackupInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const dataToRestore = parsed && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!dataToRestore || typeof dataToRestore !== "object" || Array.isArray(dataToRestore)) {
      throw new Error("Invalid backup file format");
    }
    await chrome.storage.local.clear();
    await chrome.storage.local.set(dataToRestore);
    await init();
  } catch (err) {
    errorBox.textContent = `Backup restore failed: ${err.message}`;
    errorBox.classList.remove("hidden");
  }
  importBackupInput.value = "";
});

init();
