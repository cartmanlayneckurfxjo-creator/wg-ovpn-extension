const HOST_NAME = "com.hermes.wg_ovpn_host";

let nativePort = null;
let protonAuth = null;
let state = {
  status: "disconnected", // disconnected | connecting | connected | error
  mode: null, // "native" | "proton"
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

async function applyProxy(scheme, host, port) {
  const { bypassList = ["localhost", "127.0.0.1", "*.local"] } = await chrome.storage.local.get("bypassList");
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme,
          host,
          port: Number(port)
        },
        bypassList
      }
    },
    scope: "regular"
  });
}

if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(
    (details) => {
      if (details.isProxy && protonAuth && protonAuth.username) {
        return {
          authCredentials: {
            username: protonAuth.username,
            password: protonAuth.password || ""
          }
        };
      }
      return {};
    },
    { urls: ["<all_urls>"] },
    ["blocking"]
  );
}

function clearProxy() {
  chrome.proxy.settings.clear({ scope: "regular" }).catch(() => {});
}

async function handleNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.status === "connected" && msg.port) {
    await applyProxy("socks5", "127.0.0.1", msg.port);
    setState({ status: "connected", mode: "native", port: msg.port, error: null });
  } else if (msg.status === "disconnected") {
    clearProxy();
    setState({ status: "disconnected", mode: null, activeProfileId: null, port: null, error: null });
  } else if (msg.error) {
    clearProxy();
    setState({ status: "error", mode: null, activeProfileId: null, port: null, error: msg.error });
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
    chrome.storage.local.get("localPort").then(({ localPort = 3322 }) => {
      try {
        const port = ensureNativePort();
        port.postMessage({ action: "connect", profile, port: Number(localPort) });
        sendResponse({ ok: true });
      } catch (e) {
        setState({ status: "error", activeProfileId: null, error: String(e) });
        sendResponse({ ok: false, error: String(e) });
      }
    });
    return true;
  }
  if (msg.type === "fetchProtonServers") {
    fetch("https://api.protonvpn.ch/vpn/logicals")
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: true, data: json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "connectProton") {
    const { server, username, password } = msg;
    if (nativePort) {
      nativePort.postMessage({ action: "disconnect" });
    }
    protonAuth = { username, password };
    applyProxy("https", server.domain, 443).then(() => {
      setState({ status: "connected", mode: "proton", activeProfileId: server.id, port: 443, error: null });
      sendResponse({ ok: true });
    }).catch((e) => {
      setState({ status: "error", mode: null, activeProfileId: null, error: String(e) });
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (msg.type === "disconnect") {
    protonAuth = null;
    clearProxy();
    if (nativePort) {
      nativePort.postMessage({ action: "disconnect" });
    }
    setState({ status: "disconnected", mode: null, activeProfileId: null, port: null, error: null });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
