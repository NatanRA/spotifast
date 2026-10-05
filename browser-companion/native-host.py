#!/usr/bin/env python3
"""Limited native-messaging relay. Never reads Spotify credentials or cookies."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys

MAX_MESSAGE = 64 * 1024


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        part = stream.read(size - len(data))
        if not part:
            if not data:
                return None
            raise ValueError("Truncated native message")
        data.extend(part)
    return bytes(data)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack("=I", header)[0]
    if size == 0 or size > MAX_MESSAGE:
        raise ValueError("Invalid native message size")
    body = read_exact(stream, size)
    if body is None:
        raise ValueError("Missing native message")
    message = json.loads(body)
    if not isinstance(message, dict) or message.get("type") != "poll":
        raise ValueError("Unsupported native request")
    if set(message) - {"type", "ack", "state", "error"}:
        raise ValueError("Unknown native request field")
    if not isinstance(message.get("state"), dict):
        raise ValueError("Missing playback state")
    ack = message.get("ack", 0)
    if isinstance(ack, bool) or not isinstance(ack, int) or ack < 0:
        raise ValueError("Invalid acknowledgement")
    return message


def write_message(stream, message):
    body = json.dumps(message, separators=(",", ":")).encode()
    if len(body) > MAX_MESSAGE:
        raise ValueError("Response too large")
    stream.write(struct.pack("=I", len(body)))
    stream.write(body)
    stream.flush()


def relay(message, ticket_path):
    ticket_path = Path(ticket_path)
    if ticket_path.is_symlink():
        raise ValueError("Invalid discovery ticket")
    details = ticket_path.stat()
    if os.name != "nt":
        if details.st_uid != os.getuid() or stat.S_IMODE(details.st_mode) & 0o077:
            raise ValueError("Discovery ticket must be private to its owner")
    if details.st_size > 4096:
        raise ValueError("Invalid discovery ticket size")
    ticket = json.loads(ticket_path.read_text())
    port = ticket["port"]
    token = ticket["token"]
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("Invalid playback port")
    if not isinstance(token, str) or len(token) != 64 or not token.isascii() or not token.isalnum():
        raise ValueError("Invalid pairing token")
    request = {"token": token, "ack": message.get("ack", 0), "state": message["state"]}
    if message.get("error"):
        # Only a bounded generic error crosses the bridge. Never page text,
        # exception stacks, request URLs, headers, or browser credentials.
        request["error"] = "Playback command failed"
    body = json.dumps(request, separators=(",", ":")).encode() + b"\n"
    if len(body) > MAX_MESSAGE:
        raise ValueError("Playback state too large")
    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
        connection.sendall(body)
        response = connection.makefile("rb").readline(MAX_MESSAGE + 1)
    if len(response) > MAX_MESSAGE or not response.endswith(b"\n"):
        raise ValueError("Invalid playback response")
    result = json.loads(response)
    if not isinstance(result, dict) or not isinstance(result.get("commands"), list):
        raise ValueError("Invalid playback response")
    result["session"] = hashlib.sha256(token.encode()).hexdigest()[:16]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticket", required=True)
    args = parser.parse_args()
    while True:
        try:
            message = read_message(sys.stdin.buffer)
            if message is None:
                return
            try:
                result = relay(message, args.ticket)
            except (OSError, ValueError, KeyError, TypeError):
                result = {"commands": [], "error": "Start Spotifast Lab with browser playback and sign in"}
            write_message(sys.stdout.buffer, result)
        except (OSError, ValueError, TypeError):
            # Untrusted input cannot turn the relay into a general-purpose
            # command runner. End the channel without printing its contents.
            return


if __name__ == "__main__":
    main()
