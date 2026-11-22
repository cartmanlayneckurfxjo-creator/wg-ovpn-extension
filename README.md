# WG & OpenVPN Proxy Extension

Chrome/Chromium MV3 extension + Windows Native Messaging host to route browser traffic (and external apps like Telegram) through WireGuard (`.conf`) or OpenVPN (`.ovpn`) tunnels.

## Features
- **WireGuard (`.conf`)** via `wireproxy.exe` -> local `SOCKS5` proxy.
- **OpenVPN (`.ovpn`, TCP/UDP)** via WSL2 (`openvpn` + `tinyproxy`) -> local `HTTP` proxy.
- **Fixed local port** (default `3322`) for Telegram / external apps.
- **Inline profile rename** (click profile name) and **Bypass list**.

## Installation

### 1. Load Chrome Extension
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `extension/`.
3. Copy the **Extension ID**.
4. (Optional) Open **Details** -> enable **Allow in Incognito**.

### 2. Register Native Messaging Host (Windows)
Run in PowerShell:
```powershell
cd native-host
.\install_host.ps1 -ExtensionId <YOUR_EXTENSION_ID>
```

### 3. WireGuard Support (`.conf`)
Download `wireproxy.exe` (Windows amd64) from `whyvl/wireproxy` releases and place it in:
```
native-host/bin/wireproxy.exe
```

### 4. OpenVPN Support (`.ovpn`) via WSL2
1. Install WSL2 Ubuntu (`wsl --install -d Ubuntu`).
2. Inside WSL Ubuntu, install `openvpn` and `tinyproxy`:
   ```sh
   sudo apt-get update && sudo apt-get install -y openvpn tinyproxy
   ```
3. In the extension popup, enter your **OpenVPN Username & Password** if the `.ovpn` config requires authentication.

### 5. Telegram / External Apps
- For **WireGuard**: use **SOCKS5** -> `127.0.0.1` : `<port>` (default `3322`).
- For **OpenVPN**: use **HTTP** -> `127.0.0.1` : `<port>` (default `3322`).
