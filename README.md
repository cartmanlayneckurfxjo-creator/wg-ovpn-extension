# WG & OpenVPN Proxy Extension + Native Host

## Setup

1. Open `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> select `f:\AI\hermes\wg-ovpn-extension\extension`.
2. Copy the generated **Extension ID** from `chrome://extensions`.
3. Register the Native Messaging host in PowerShell:
   ```powershell
   cd f:\AI\hermes\wg-ovpn-extension\native-host
   .\install_host.ps1 -ExtensionId <YOUR_EXTENSION_ID>
   ```
4. Download `wireproxy.exe` (for WireGuard `.conf` -> local SOCKS5) and place it in `native-host\bin\wireproxy.exe` (or anywhere in `PATH`).
5. Click the extension icon, import a `.conf` file, and click **Connect**.
