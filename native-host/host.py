import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
BIN_DIR = BASE_DIR / "bin"

active_proc = None
active_tmp_dir = None


def send_message(payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    if not raw_msg:
        return None
    return json.loads(raw_msg.decode("utf-8"))


def find_binary(name: str) -> str | None:
    for candidate in (BIN_DIR / f"{name}.exe", BIN_DIR / name):
        if candidate.is_file():
            return str(candidate)
    return shutil.which(name)


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_port(port: int, proc: subprocess.Popen, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def stop_tunnel() -> None:
    global active_proc, active_tmp_dir
    if active_proc is not None:
        try:
            active_proc.terminate()
            active_proc.wait(timeout=3)
        except Exception:
            try:
                active_proc.kill()
            except Exception:
                pass
        active_proc = None
    if active_tmp_dir is not None:
        shutil.rmtree(active_tmp_dir, ignore_errors=True)
        active_tmp_dir = None


def start_wireguard(config_text: str, requested_port: int = 0) -> dict:
    global active_proc, active_tmp_dir
    wireproxy = find_binary("wireproxy")
    if not wireproxy:
        return {"error": "wireproxy.exe not found in native-host/bin or PATH"}

    port = requested_port if 0 < requested_port <= 65535 else pick_free_port()
    active_tmp_dir = tempfile.mkdtemp(prefix="wg_ovpn_")
    conf_path = Path(active_tmp_dir) / "wg.conf"

    # Enforce optimal MTU = 1280 for stability without packet fragmentation
    lines = []
    has_mtu = False
    for line in config_text.splitlines():
        if line.strip().lower().startswith("mtu"):
            has_mtu = True
            lines.append("MTU = 1280")
        else:
            lines.append(line)
            if line.strip().lower() == "[interface]" and not has_mtu:
                lines.append("MTU = 1280")

    cleaned = "\n".join(lines).strip()
    if "[Socks5]" not in cleaned:
        cleaned += f"\n\n[Socks5]\nBindAddress = 127.0.0.1:{port}\n"

    conf_path.write_text(cleaned, encoding="utf-8")
    active_proc = subprocess.Popen(
        [wireproxy, "-c", str(conf_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    if not wait_for_port(port, active_proc):
        err = ""
        if active_proc.stderr:
            err = active_proc.stderr.read().decode("utf-8", errors="replace").strip()
        stop_tunnel()
        return {"error": err or "wireproxy failed to start"}

    return {"status": "connected", "port": port}


def start_openvpn(config_text: str) -> dict:
    global active_proc, active_tmp_dir
    openvpn = find_binary("openvpn")
    if not openvpn:
        return {"error": "openvpn.exe not found in native-host/bin or PATH"}

    return {
        "error": "OpenVPN creates a system TUN interface (requires Admin + TAP/Wintun), not a local SOCKS5 port. Use WireGuard + wireproxy for browser-only proxy."
    }


def main() -> None:
    try:
        while True:
            msg = read_message()
            if msg is None:
                break
            action = msg.get("action")
            if action == "disconnect":
                stop_tunnel()
                send_message({"status": "disconnected"})
            elif action == "connect":
                stop_tunnel()
                profile = msg.get("profile") or {}
                ptype = profile.get("type", "wg")
                config_text = profile.get("config", "")
                if ptype == "wg":
                    req_port = int(msg.get("port") or 0)
                    send_message(start_wireguard(config_text, req_port))
                elif ptype == "ovpn":
                    send_message(start_openvpn(config_text))
                else:
                    send_message({"error": f"Unknown profile type: {ptype}"})
            elif action == "status":
                send_message({"status": "connected" if active_proc and active_proc.poll() is None else "disconnected"})
    finally:
        stop_tunnel()


if __name__ == "__main__":
    main()
