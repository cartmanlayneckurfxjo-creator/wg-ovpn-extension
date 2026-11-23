const HOST_NAME = "com.hermes.wg_ovpn_host";

let nativePort = null;
let state = {
  status: "disconnected", // disconnected | connecting | connected | error
  activeProfileId: null,
  port: null,
  error: null
};

function setState(patch) {
  state = { ...state, ...patch };
  chrome.storage.local.set({ vpnState: state });
  chrome.runtime.sendMessage({ type: "state", state }).catch(() => {});
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Native host disconnected";
    nativePort = null;
    clearProxy();
    if (state.status !== "disconnected") {
      setState({ status: "error", activeProfileId: null, port: null, error: err });
    }
  });
  return nativePort;
}

async function applyProxy(scheme, port) {
  const { bypassList = ["localhost", "127.0.0.1", "*.local"] } = await chrome.storage.local.get("bypassList");
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme,
          host: "127.0.0.1",
          port: Number(port)
        },
        bypassList
      }
    },
    scope: "regular"
  });
}

async function clearProxy() {
  const { killswitch = false } = await chrome.storage.local.get("killswitch");
  if (killswitch) {
    await applyProxy("http", 1).catch(() => {});
  } else {
    chrome.proxy.settings.clear({ scope: "regular" }).catch(() => {});
  }
}

async function handleNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.status === "connected" && msg.port) {
    const scheme = msg.scheme || "socks5";
    await applyProxy(scheme, msg.port);
    setState({ status: "connected", port: msg.port, error: null });
  } else if (msg.status === "disconnected") {
    clearProxy();
    setState({ status: "disconnected", activeProfileId: null, port: null, error: null });
  } else if (msg.error) {
    clearProxy();
    setState({ status: "error", activeProfileId: null, port: null, error: msg.error });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getState") {
    sendResponse(state);
    return true;
  }
  if (msg.type === "connect") {
    const { profile } = msg;
    setState({ status: "connecting", activeProfileId: profile.id, error: null });
    chrome.storage.local.get(["localPort", "ovpnUser", "ovpnPass", "protonUser", "protonPass", "viaTor"]).then((st) => {
      try {
        const port = ensureNativePort();
        port.postMessage({
          action: "connect",
          profile,
          port: Number(st.localPort || 3322),
          user: st.ovpnUser || st.protonUser || "",
          pass: st.ovpnPass || st.protonPass || "",
          viaTor: Boolean(st.viaTor)
        });
        sendResponse({ ok: true });
      } catch (e) {
        setState({ status: "error", activeProfileId: null, error: String(e) });
        sendResponse({ ok: false, error: String(e) });
      }
    });
    return true;
  }
  if (msg.type === "disconnect") {
    clearProxy();
    if (nativePort) {
      nativePort.postMessage({ action: "disconnect" });
    }
    setState({ status: "disconnected", activeProfileId: null, port: null, error: null });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "updateKillswitch") {
    if (state.status !== "connected") {
      clearProxy();
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

if (state.status !== "connected") {
  clearProxy();
}
