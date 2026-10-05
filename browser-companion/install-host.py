#!/usr/bin/env python3
"""Register the limited companion host for a chosen browser. No extension install."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import sys


def extension_id(manifest):
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest)


def destination(browser, home, platform):
    if platform == "darwin":
        return home / "Library/Application Support" / {
            "brave": "BraveSoftware/Brave-Browser", "chrome": "Google/Chrome",
            "chromium": "Chromium",
        }[browser] / "NativeMessagingHosts"
    if platform.startswith("linux"):
        return home / ".config" / {
            "brave": "BraveSoftware/Brave-Browser", "chrome": "google-chrome",
            "chromium": "chromium",
        }[browser] / "NativeMessagingHosts"
    raise ValueError("Automatic host registration currently supports macOS and Linux")


def default_ticket(home, platform):
    if platform == "darwin":
        return home / "Library/Application Support/me.paolino.spotifast-lab/browser-player.json"
    if platform.startswith("linux"):
        import os
        state = Path(os.environ.get("XDG_STATE_HOME", home / ".local/state"))
        return state / "spotifast-lab/browser-player.json"
    raise ValueError("Pass the native app's ticket path explicitly on this platform")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=["brave", "chrome", "chromium"], default="brave")
    parser.add_argument("--ticket", type=Path)
    parser.add_argument("--install", action="store_true", help="Write host registration; otherwise preview it")
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    manifest = json.loads((directory / "manifest.json").read_text())
    host_name = "io.github.natanra.spotifast_lab"
    host_directory = destination(args.browser, Path.home(), sys.platform)
    ticket = args.ticket or default_ticket(Path.home(), sys.platform)
    launcher = directory / "host-launcher.sh"
    host = {
        "name": host_name,
        "description": "Spotifast Lab playback command relay",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id(manifest)}/"],
    }
    target = host_directory / f"{host_name}.json"
    print(f"Browser: {args.browser}\nExtension ID: {extension_id(manifest)}\nRegistration: {target}\nTicket: {ticket}")
    if args.install:
        script = "#!/bin/sh\nexec " + " ".join(shlex.quote(str(value)) for value in (
            sys.executable, directory / "native-host.py", "--ticket", ticket,
        )) + "\n"
        launcher.write_text(script)
        launcher.chmod(0o700)
        host_directory.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(host, indent=2) + "\n")
        target.chmod(0o600)
        print("Native host registered. The browser extension still requires a separate installation.")
    else:
        print("Preview only. Pass --install to register this host.")


if __name__ == "__main__":
    main()
