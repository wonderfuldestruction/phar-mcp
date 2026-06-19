#!/usr/bin/env python3
"""Invoke a phar-mcp tool via stdio JSON-RPC.

Usage:
    python3 scripts/call.py <tool_name> '<json_args>'
    python3 scripts/call.py pharaoh_contracts_get '{}'
"""

import json
import subprocess
import sys
import os

TIMEOUT = 15
SERVER_CMD = ["node", os.path.join(os.path.dirname(__file__), "..", "dist", "index.js")]


def _read_line(proc: subprocess.Popen) -> str | None:
    """Read one newline-delimited JSON-RPC message from stdout."""
    line = proc.stdout.readline()
    if not line:
        return None
    return line.strip()


def _send(proc: subprocess.Popen, msg: dict) -> None:
    """Write a JSON-RPC message to stdin."""
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()


def _recv(proc: subprocess.Popen, id_: int) -> dict:
    """Read response, match by id, raise on error."""
    while True:
        raw = _read_line(proc)
        if raw is None:
            raise RuntimeError("Server closed stdout unexpectedly")
        resp = json.loads(raw)
        if resp.get("id") == id_:
            if "error" in resp:
                err = resp["error"]
                raise RuntimeError(f"JSON-RPC error {err.get('code')}: {err.get('message')}")
            return resp
        # ignore out-of-order or notification messages


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <tool_name> '<json_args>'", file=sys.stderr)
        return 1

    tool_name = sys.argv[1]
    try:
        tool_args = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        print(f"Invalid JSON args: {e}", file=sys.stderr)
        return 1

    try:
        proc = subprocess.Popen(
            SERVER_CMD,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except Exception as e:
        print(f"Failed to start server: {e}", file=sys.stderr)
        return 1

    try:
        # 1) initialize
        _send(proc, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "call.py", "version": "1.0.0"},
            },
        })
        init_resp = _recv(proc, 1)
        _ = init_resp  # server capabilities available if needed

        # 2) notifications/initialized
        _send(proc, {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })

        # 3) tools/call
        _send(proc, {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": tool_args,
            },
        })
        result = _recv(proc, 2)

        # extract content text (MCP tool response shape)
        tool_result = result.get("result", {})
        is_error = tool_result.get("isError", False)
        content = tool_result.get("content", [])

        if content:
            for item in content:
                if item.get("type") == "text":
                    text = item["text"]
                    if is_error or text.startswith("MCP error"):
                        print(text, file=sys.stderr)
                    else:
                        print(text)
                else:
                    out = sys.stderr if is_error else sys.stdout
                    print(json.dumps(item, indent=2), file=out)
        else:
            out = sys.stderr if is_error else sys.stdout
            print(json.dumps(tool_result, indent=2), file=out)

        return 1 if is_error else 0

    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as e:
        print(f"Malformed server response: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 3
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
