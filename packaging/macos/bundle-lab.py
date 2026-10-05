#!/usr/bin/env python3
"""Build an isolated, ad-hoc-signed Spotifast Lab.app from a macOS binary."""

import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

IDENTIFIER = "io.github.natanra.SpotifastLab"


def build(binary, app, version):
    if sys.platform != "darwin":
        raise ValueError("The app bundle must be built on macOS")
    binary = binary.resolve(strict=True)
    app = app.absolute()
    if app.suffix != ".app":
        raise ValueError("Output must be an .app directory")
    if app.exists():
        # Rebuild only our own output, never an arbitrary application.
        existing = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        if existing.get("CFBundleIdentifier") != IDENTIFIER:
            raise ValueError("Refusing to replace an unrelated application")
        shutil.rmtree(app)
    executable = app / "Contents/MacOS"
    resources = app / "Contents/Resources"
    executable.mkdir(parents=True)
    resources.mkdir()
    shutil.copy2(binary, executable / "spotifast-bin")
    (executable / "spotifast-bin").chmod(0o755)
    launcher = executable / "Spotifast"
    launcher.write_text('#!/bin/sh\nexec "$(dirname "$0")/spotifast-bin" --browser-playback "$@"\n')
    launcher.chmod(0o755)
    info = {
        "CFBundleName": "Spotifast Lab", "CFBundleDisplayName": "Spotifast Lab",
        "CFBundleIdentifier": IDENTIFIER, "CFBundleExecutable": "Spotifast",
        "CFBundleIconFile": "spotifast", "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version, "CFBundleVersion": version.split("-")[0],
        "LSMinimumSystemVersion": "11.0", "LSApplicationCategoryType": "public.app-category.music",
        "NSHighResolutionCapable": True,
        "NSHumanReadableCopyright": "© 2026 Carmine Paolino. MIT License. Not affiliated with Spotify AB.",
    }
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    # No Spotify URL-scheme registration: installing the lab must not replace
    # the user's existing choice of app for spotify: links.
    icon = Path(__file__).parent / "icon-1024.png"
    with tempfile.TemporaryDirectory(prefix="spotifast-lab-icon-") as temporary:
        iconset = Path(temporary) / "spotifast.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale, suffix in ((1, ""), (2, "@2x")):
                subprocess.run(["sips", "-z", str(size * scale), str(size * scale), str(icon),
                                "--out", str(iconset / f"icon_{size}x{size}{suffix}.png")],
                               check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "spotifast.icns")], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-", str(executable / "spotifast-bin")], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    print(app)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("app", type=Path)
    parser.add_argument("version")
    args = parser.parse_args()
    build(args.binary, args.app, args.version)


if __name__ == "__main__":
    main()
