import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
BIN_DIR = BASE_DIR / "bin"

active_proc = None
active_tmp_dir = None
tor_relay_sock = None


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


def ensure_wsl_dockerd():
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        chk = subprocess.run(
            ["wsl", "-d", "Ubuntu", "-u", "root", "docker", "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
            creationflags=flags,
        )
        if chk.returncode == 0:
            return
    except Exception:
        pass

    try:
        subprocess.Popen(
            ["wsl", "-d", "Ubuntu", "-u", "root", "dockerd"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
        for _ in range(20):
            time.sleep(0.5)
            chk = subprocess.run(
                ["wsl", "-d", "Ubuntu", "-u", "root", "docker", "info"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
                creationflags=flags,
            )
            if chk.returncode == 0:
                return
    except Exception:
        pass


def stop_gluetun():
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.run(
            ["wsl", "-d", "Ubuntu", "-u", "root", "sh", "-c", "pkill -f 'openvpn.*gluetun_ovpn' || true; pkill -f 'tinyproxy.*gluetun_ovpn' || true; docker rm -f hermes_ovpn_gluetun >/dev/null 2>&1 || true"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            creationflags=flags,
        )
    except Exception:
        pass


def stop_tor_relay() -> None:
    global tor_relay_sock
    if tor_relay_sock:
        try:
            tor_relay_sock.close()
        except Exception:
            pass
        tor_relay_sock = None


def _pipe_sockets(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(16384)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for s in (src, dst):
            try:
                s.close()
            except Exception:
                pass


def start_tor_relay(target_port: int = 9052) -> int:
    global tor_relay_sock
    stop_tor_relay()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", 0))
    srv.listen(32)
    tor_relay_sock = srv
    fwd_port = srv.getsockname()[1]

    def accept_loop():
        while True:
            try:
                client, _ = srv.accept()
            except Exception:
                break
            try:
                remote = socket.create_connection(("127.0.0.1", target_port), timeout=5.0)
                threading.Thread(target=_pipe_sockets, args=(client, remote), daemon=True).start()
                threading.Thread(target=_pipe_sockets, args=(remote, client), daemon=True).start()
            except Exception:
                try:
                    client.close()
                except Exception:
                    pass

    threading.Thread(target=accept_loop, daemon=True).start()
    return fwd_port


def stop_tunnel() -> None:
    global active_proc, active_tmp_dir
    stop_tor_relay()
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
    stop_gluetun()


def start_openvpn(config_text: str, requested_port: int = 0, user: str = "", password: str = "", via_tor: bool = False) -> dict:
    stop_gluetun()

    port = requested_port if 0 < requested_port <= 65535 else 3322
    wsl_conf_dir = "/tmp/gluetun_ovpn"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run(["wsl", "-d", "Ubuntu", "-u", "root", "mkdir", "-p", wsl_conf_dir], check=False, creationflags=flags)

    ovpn_clean = config_text.replace("\r\n", "\n")

    if via_tor:
        try:
            with socket.create_connection(("127.0.0.1", 9052), timeout=1.0):
                pass
        except OSError:
            return {"error": "Tor not running on 127.0.0.1:9052. Start TorControlPanel.exe first."}
        fwd_port = start_tor_relay(9052)
        gw_res = subprocess.run(
            ["wsl", "-d", "Ubuntu", "-u", "root", "sh", "-c", "ip route show | awk '/default/ {print $3}'"],
            capture_output=True, text=True, creationflags=flags
        )
        win_ip = gw_res.stdout.strip().splitlines()[0] if gw_res.stdout.strip() else "172.17.0.1"
        ovpn_clean = "\n".join(
            line for line in ovpn_clean.splitlines()
            if not line.strip().startswith("socks-proxy")
        )
        ovpn_clean += f"\nsocks-proxy {win_ip} {fwd_port}\n"
    needs_auth = "auth-user-pass" in ovpn_clean and "<auth-user-pass>" not in ovpn_clean
    if needs_auth and not user:
        return {"error": "OpenVPN config requires Username & Password (enter them below)"}

    if user:
        if needs_auth:
            ovpn_clean = "\n".join(
                f"auth-user-pass {wsl_conf_dir}/auth.txt" if line.strip().startswith("auth-user-pass") else line
                for line in ovpn_clean.splitlines()
            )
        else:
            ovpn_clean += f"\nauth-user-pass {wsl_conf_dir}/auth.txt\n"
        subprocess.run(
            ["wsl", "-d", "Ubuntu", "-u", "root", "tee", f"{wsl_conf_dir}/auth.txt"],
            input=f"{user}\n{password}\n".encode("utf-8"),
            stdout=subprocess.DEVNULL,
            check=False,
            creationflags=flags,
        )

    subprocess.run(
        ["wsl", "-d", "Ubuntu", "-u", "root", "tee", f"{wsl_conf_dir}/custom.ovpn"],
        input=ovpn_clean.encode("utf-8"),
        stdout=subprocess.DEVNULL,
        check=False,
        creationflags=flags,
    )

    tiny_conf = f"Port {port}\nListen 0.0.0.0\nAllow 127.0.0.1\nAllow ::1\nAllow 172.16.0.0/12\nConnectPort 443\nConnectPort 80\n"
    subprocess.run(
        ["wsl", "-d", "Ubuntu", "-u", "root", "tee", f"{wsl_conf_dir}/tinyproxy.conf"],
        input=tiny_conf.encode("utf-8"),
        stdout=subprocess.DEVNULL,
        check=False,
        creationflags=flags,
    )

    subprocess.Popen(
        [
            "wsl", "-d", "Ubuntu", "-u", "root", "sh", "-c",
            f"rm -f {wsl_conf_dir}/ovpn.log; "
            f"openvpn --config {wsl_conf_dir}/custom.ovpn --log {wsl_conf_dir}/ovpn.log & "
            f"tinyproxy -d -c {wsl_conf_dir}/tinyproxy.conf"
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
    )

    deadline = time.monotonic() + 45.0
    while time.monotonic() < deadline:
        tun_chk = subprocess.run(
            ["wsl", "-d", "Ubuntu", "-u", "root", "ip", "link", "show", "tun0"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            creationflags=flags,
        )
        if tun_chk.returncode == 0:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    return {"status": "connected", "port": port, "scheme": "http"}
            except OSError:
                pass
        time.sleep(0.5)

    log_res = subprocess.run(
        ["wsl", "-d", "Ubuntu", "-u", "root", "tail", "-n", "12", f"{wsl_conf_dir}/ovpn.log"],
        capture_output=True, text=True, creationflags=flags
    )
    stop_gluetun()
    return {"error": log_res.stdout.strip() or "OpenVPN tunnel timed out"}


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
                req_port = int(msg.get("port") or 0)
                try:
                    if ptype == "wg":
                        send_message(start_wireguard(config_text, req_port))
                    elif ptype == "ovpn":
                        user = msg.get("user", "")
                        pwd = msg.get("pass", "")
                        via_tor = bool(msg.get("viaTor", False))
                        send_message(start_openvpn(config_text, req_port, user, pwd, via_tor))
                    else:
                        send_message({"error": f"Unknown profile type: {ptype}"})
                except Exception as ex:
                    send_message({"error": f"Error: {ex}"})
            elif action == "status":
                send_message({"status": "connected" if (active_proc and active_proc.poll() is None) else "disconnected"})
    except Exception as e:
        send_message({"error": f"Fatal host error: {e}"})
    finally:
        stop_tunnel()


if __name__ == "__main__":
    main()
