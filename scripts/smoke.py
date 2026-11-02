#!/usr/bin/env python3
"""Smoke-test the packaged binary with disposable local data and synthetic credentials."""

import base64
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def request(base, path, body=None, token=""):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main():
    binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else "bin/pith-post").resolve())
    env = os.environ.copy()
    env["PITH_POST_MASTER_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
    password = "smoke-only-" + secrets.token_hex(16)
    with tempfile.TemporaryDirectory(prefix="pith-post-smoke-") as directory:
        data = str(Path(directory) / "data")
        subprocess.run(
            [binary, "superuser", "create", "smoke@example.test", password, "--dir=" + data],
            env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        base = "http://127.0.0.1:" + str(port)
        agent_id = None
        for iteration in range(2):
            with tempfile.TemporaryFile() as logs:
                process = subprocess.Popen(
                    [binary, "serve", "--http=127.0.0.1:" + str(port), "--dir=" + data],
                    env=env, stdout=logs, stderr=logs,
                )
                try:
                    deadline = time.monotonic() + 20
                    while True:
                        if process.poll() is not None:
                            raise AssertionError("binary exited before becoming healthy")
                        try:
                            status, _ = request(base, "/api/health")
                            if status == 200:
                                break
                        except (OSError, urllib.error.URLError):
                            pass
                        if time.monotonic() > deadline:
                            raise AssertionError("binary did not become healthy")
                        time.sleep(0.1)
                    status, page = request(base, "/post/")
                    assert status == 200 and b"Pith Post" in page, "embedded view is unavailable"
                    status, _ = request(base, "/api/post/agents")
                    assert status in (401, 403), "anonymous management request was accepted"
                    status, body = request(base, "/api/collections/_superusers/auth-with-password", {
                        "identity": "smoke@example.test", "password": password,
                    })
                    assert status == 200, "superuser authentication failed"
                    token = json.loads(body)["token"]
                    if iteration == 0:
                        status, body = request(base, "/api/collections/owners/records", {
                            "name": "Smoke owner", "mxid": "@owner:example.test",
                        }, token)
                        assert status == 200, "owner CRUD failed"
                        owner_id = json.loads(body)["id"]
                        status, body = request(base, "/api/collections/agents/records", {
                            "name": "Smoke agent", "owner": owner_id,
                            "bot_mxid": "@bot:example.test", "homeserver": "https://example.test",
                            "system_prompt": "You are a smoke-test assistant.",
                            "model": "test-model", "model_url": "http://127.0.0.1:11434/v1",
                            "model_api": "openai-completions", "context_window": 4096,
                            "max_tokens": 256, "auto_start": False, "auto_reset": False,
                        }, token)
                        assert status == 200, "agent CRUD failed"
                        agent_id = json.loads(body)["id"]
                        status, _ = request(base, "/api/post/agents/" + agent_id + "/credentials", {
                            "password": "synthetic-bot-password", "model_key": "synthetic-model-key",
                        }, token)
                        assert status == 200, "encrypted credential entry failed"
                    status, body = request(base, "/api/post/agents", token=token)
                    assert status == 200, "management list failed"
                    agents = json.loads(body)
                    assert len(agents) == 1 and agents[0]["config"]["id"] == agent_id, "configuration did not persist"
                    assert agents[0]["credentials"], "encrypted credentials did not persist"
                    assert b"synthetic-model-key" not in body and b"synthetic-bot-password" not in body, "API exposed credentials"
                    # Starting a second process with the same data directory must fail.
                    collision = subprocess.run(
                        [binary, "serve", "--http=127.0.0.1:0", "--dir=" + data],
                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                    )
                    assert collision.returncode != 0, "second process acquired the same data directory"
                finally:
                    process.send_signal(signal.SIGTERM)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                        raise AssertionError("binary did not shut down gracefully")
                logs.seek(0)
                output = logs.read()
                for secret in (password, env["PITH_POST_MASTER_KEY"], "synthetic-model-key", "synthetic-bot-password"):
                    assert secret.encode() not in output, "application logs exposed a secret"
        print("Smoke test passed: embedded UI, superuser-only management, CRUD, secret persistence, process restart, and data lock.")


if __name__ == "__main__":
    main()
