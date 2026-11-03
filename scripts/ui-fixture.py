#!/usr/bin/env python3
"""Disposable browser-test server. Uses synthetic accounts and never starts a Matrix bot."""
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import os
from pathlib import Path
import secrets
import signal
import struct
import zlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse

def avatar_fixture(red, green, blue):
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xffffffff)
    raw = b"".join(b"\0" + bytes([red, green, blue, 255]) * 16 for _ in range(16))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return base64.b64encode(png).decode()

class MatrixFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path == "/_matrix/client/v3/profile/@morgan:example.test":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"avatar_url":"mxc://fixture.test/person-avatar"}')
        elif path == "/_matrix/client/v1/media/thumbnail/fixture.test/person-avatar":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(base64.b64decode(avatar_fixture(37, 99, 235)))
        elif path == "/_matrix/client/versions":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"versions":["v1.11"]}')
        else:
            self.send_error(404)
    def log_message(self, *_):
        pass

matrix = ThreadingHTTPServer(("127.0.0.1", 0), MatrixFixture)
threading.Thread(target=matrix.serve_forever, daemon=True).start()
matrix_url = "http://127.0.0.1:" + str(matrix.server_port)

binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="pith-ui-") as directory:
    env = os.environ.copy()
    env["PITH_POST_MASTER_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
    password = "synthetic-browser-test-password"
    email = "browser@example.test"
    data = str(Path(directory) / "data")
    subprocess.run([binary, "superuser", "create", email, password, "--dir=" + data], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryFile() as logs:
        process = subprocess.Popen([binary, "serve", "--http=127.0.0.1:" + str(port), "--dir=" + data], env=env, stdout=logs, stderr=logs)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen("http://127.0.0.1:" + str(port) + "/api/health", timeout=1).close()
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError("Fixture failed to start")
            # Runtime/model configuration is provisioned by the operator, outside the product UI.
            def post(path, body, token=""):
                request = urllib.request.Request("http://127.0.0.1:" + str(port) + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **({"Authorization": token} if token else {})})
                with urllib.request.urlopen(request, timeout=3) as response:
                    return json.load(response)
            token = post("/api/collections/_superusers/auth-with-password", {"identity": email, "password": password})["token"]
            post("/api/post/connections", {"name": "Fixture runtime", "model": "fixture-model", "url": "http://127.0.0.1:1/v1", "api": "openai-completions", "context_window": 8192, "max_tokens": 1024}, token)
            print(json.dumps({"url": "http://127.0.0.1:" + str(port), "email": email, "password": password, "matrix": matrix_url, "images": {"blue": avatar_fixture(37, 99, 235), "green": avatar_fixture(16, 185, 129)}}), flush=True)
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            signal.pause()
        finally:
            process.terminate()
            process.wait(timeout=20)
