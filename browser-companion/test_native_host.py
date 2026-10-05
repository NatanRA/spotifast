import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("native_host", Path(__file__).with_name("native-host.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class NativeHostTests(unittest.TestCase):
    def message(self, value):
        body = json.dumps(value).encode()
        return io.BytesIO(struct.pack("=I", len(body)) + body)

    def test_rejects_oversized_and_truncated_messages(self):
        with self.assertRaises(ValueError):
            host.read_message(io.BytesIO(struct.pack("=I", host.MAX_MESSAGE + 1)))
        with self.assertRaises(ValueError):
            host.read_message(io.BytesIO(struct.pack("=I", 20) + b"{}"))

    def test_rejects_arbitrary_command_execution_requests(self):
        with self.assertRaises(ValueError):
            host.read_message(self.message({"type": "exec", "command": "anything"}))
        with self.assertRaises(ValueError):
            host.read_message(self.message({"type": "poll", "state": {}, "path": "/other"}))

    def test_native_response_framing(self):
        output = io.BytesIO()
        host.write_message(output, {"commands": []})
        data = output.getvalue()
        self.assertEqual(struct.unpack("=I", data[:4])[0], len(data) - 4)
        self.assertEqual(json.loads(data[4:]), {"commands": []})

    @unittest.skipIf(os.name == "nt", "Unix file modes")
    def test_refuses_ticket_readable_by_other_users(self):
        with tempfile.TemporaryDirectory() as directory:
            ticket = Path(directory) / "ticket.json"
            ticket.write_text(json.dumps({"port": 1, "token": "x" * 64}))
            ticket.chmod(0o644)
            with self.assertRaises(ValueError):
                host.relay({"type": "poll", "state": {}}, ticket)

    def test_authenticated_loopback_round_trip_and_error_redaction(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen()
            ticket = Path(directory) / "ticket.json"
            ticket.write_text(json.dumps({"port": server.getsockname()[1], "token": "x" * 64}))
            ticket.chmod(0o600)
            received = []

            def serve():
                connection, _ = server.accept()
                with connection:
                    received.append(json.loads(connection.makefile("rb").readline()))
                    connection.sendall(b'{"commands":[]}\n')

            worker = threading.Thread(target=serve)
            worker.start()
            reply = host.relay({"type": "poll", "ack": 0, "state": {"account_id": "owner"},
                                "error": "SECRET DATA IN A PAGE ERROR"}, ticket)
            worker.join(timeout=3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(received[0]["token"], "x" * 64)
            self.assertEqual(received[0]["error"], "Playback command failed")
            self.assertNotIn("token", reply)
            self.assertEqual(len(reply["session"]), 16)


if __name__ == "__main__":
    unittest.main()
