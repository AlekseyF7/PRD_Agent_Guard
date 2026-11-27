"""Real OpenCode, generated profile, controlled local model; disposable data only.
This checks enforcement, not real model reasoning or human approval.
Run from the repository root after npm run build.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix="agent-guard-004-", dir="/private/tmp" if os.name != "nt" else None)).resolve()
node, cli = shutil.which("node"), shutil.which("opencode")
if not node or not cli:
    raise SystemExit("Node and OpenCode must be in PATH")
outside = root / "outside.txt"
outside.write_text("OUTSIDE-SYNTHETIC\n")
results = []
print("Evidence directory:", root, flush=True)

for scenario in ["read", "shell", "write", "edit", "subagent", "execute", "external-read", "guard"]:
    folder = root / scenario
    folder.mkdir()
    sample = folder / "sample.txt"
    sample.write_text("ORIGINAL-SYNTHETIC\n")
    config_path = root / (scenario + "-guard.json")
    config_path.write_text(json.dumps({"workspaceRoot": str(folder), "policies": {
        "file_delete": "block", "git_destructive": "block", "git_force_push": "block", "outside_workspace": "block"
    }, "llm": {"baseURL": "http://127.0.0.1:1/v1", "model": "unused", "timeoutMs": 1000, "authMode": "none"}}))
    subprocess.run([node, str(repo / "scripts/setup-opencode.mjs"), str(folder), str(config_path)], check=True, capture_output=True)
    forced = False
    catalog = set()
    instructions_seen = False
    calls = {
        "read": ("read", {"path": str(sample)}),
        "shell": ("shell", {"command": "printf BYPASS > shell-marker.txt", "workdir": str(folder)}),
        "write": ("write", {"path": str(folder / "write-marker.txt"), "content": "BYPASS"}),
        "edit": ("edit", {"path": str(sample), "oldString": "ORIGINAL-SYNTHETIC", "newString": "BYPASS"}),
        "subagent": ("subagent", {"agent": "explore", "description": "Synthetic denial test", "prompt": "Return TEST only"}),
        "execute": ("execute", {"code": "return 'SYNTHETIC';"}),
        "external-read": ("read", {"path": str(outside)}),
        "guard": ("guard_guard_execute_command", {"command": "rm -- sample.txt", "cwd": str(folder)}),
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            global forced, instructions_seen
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            instructions_seen |= "Agent Guard: порядок работы в этом проекте" in json.dumps(body, ensure_ascii=False)
            tools = body.get("tools", [])
            catalog.update(t.get("function", {}).get("name") for t in tools)
            choice = None
            if tools and not forced:
                forced = True
                name, arguments = calls[scenario]
                choice = {"index": 0, "id": "synthetic-call", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
            delta = {"role": "assistant", "tool_calls": [choice]} if choice else {"role": "assistant", "content": "Synthetic check finished."}
            finish = "tool_calls" if choice else "stop"
            if body.get("stream"):
                chunks = [{"id": "synthetic", "object": "chat.completion.chunk", "created": int(time.time()), "model": "probe", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                          {"id": "synthetic", "object": "chat.completion.chunk", "created": int(time.time()), "model": "probe", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}]
                data = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
                content_type = "text/event-stream"
            else:
                message = {"role": "assistant", "content": None, "tool_calls": [choice]} if choice else delta
                data = json.dumps({"id": "synthetic", "object": "chat.completion", "created": int(time.time()), "model": "probe", "choices": [{"index": 0, "message": message, "finish_reason": finish}]}).encode()
                content_type = "application/json"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config_file = folder / "opencode.json"
    config = json.loads(config_file.read_text())
    config["providers"] = {"probe": {"name": "Synthetic local probe", "env": [], "package": "@opencode/ai/providers/openai-compatible", "settings": {"apiKey": "synthetic-not-a-secret", "baseURL": f"http://127.0.0.1:{server.server_port}/v1"}, "models": {"probe": {"name": "Probe"}}}}
    config_file.write_text(json.dumps(config))
    try:
        env = dict(os.environ, PWD=str(folder))
        env.pop("AGENT_GUARD_LLM_API_KEY", None)
        run = subprocess.run([cli, "run", "--standalone", "--model", "probe/probe", "--agent", "build", "--format", "json", "Проверь тестовый проект."], cwd=folder, env=env, capture_output=True, text=True, timeout=60)
        (folder / "cli.jsonl").write_text(run.stdout)
        events = []
        for line in run.stdout.splitlines():
            try:
                event = json.loads(line)
                if event.get("type") == "tool_use":
                    events.append(event)
            except ValueError:
                pass
        tool_text = json.dumps(events, ensure_ascii=False)
        states = [event.get("part", {}).get("state", {}) for event in events]
        unchanged = sample.read_text() == "ORIGINAL-SYNTHETIC\n" and not (folder / "shell-marker.txt").exists() and not (folder / "write-marker.txt").exists()
        if scenario == "read":
            enforced = any(s.get("status") == "completed" and "ORIGINAL-SYNTHETIC" in s.get("output", "") for s in states)
        elif scenario == "guard":
            enforced = any('"code":"POLICY_BLOCK"' in s.get("error", "") for s in states)
        elif scenario == "external-read":
            enforced = "OUTSIDE-SYNTHETIC" not in tool_text and any(s.get("error") == "Blocked by configuration policy" for s in states)
        elif scenario == "execute":
            enforced = any('No tool named "execute" is currently available' in s.get("error", "") for s in states)
        else:
            enforced = any(s.get("error") == "Blocked by configuration policy" for s in states)
        result = {"scenario": scenario, "exitCode": run.returncode, "forced": forced, "instructionsSeen": instructions_seen, "catalog": sorted(catalog), "fixtureUnchanged": unchanged, "enforced": enforced}
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        server.shutdown()

(root / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
if not all(r["exitCode"] == 0 and r["forced"] and r["instructionsSeen"] and r["fixtureUnchanged"] and r["enforced"] for r in results):
    raise SystemExit(1)
