"""End-to-end test of the webhook agent's HTTP handling (signature check, routing, queueing).

Runs anywhere Python 3 runs: the POSIX-only fcntl module is stubbed and the actual deploy
is replaced with a recorder, so this exercises everything except the shell-out itself.

    python test/agent_test.py
"""
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import types
import urllib.error
import urllib.request

if "fcntl" not in sys.modules:
    try:
        import fcntl  # noqa: F401
    except ImportError:
        sys.modules["fcntl"] = types.SimpleNamespace(flock=lambda *a: None, LOCK_EX=2, LOCK_UN=8)

tmp = tempfile.mkdtemp()
SECRET = "s3cret"
cfg_path = os.path.join(tmp, "config.json")
with open(cfg_path, "w") as f:
    json.dump({"secret": SECRET, "listen": "127.0.0.1", "port": 0, "projects": [
        {"name": "app", "repo": "Me/App", "branch": "master", "path": "/srv/app"},
        {"name": "manual", "repo": "me/app", "branch": "master", "path": "/srv/m", "auto": False},
        {"name": "other", "repo": "me/other", "branch": "main", "path": "/srv/other"},
    ]}, f)
os.environ["DEPLOY_AGENT_CONFIG"] = cfg_path
os.environ["DEPLOY_AGENT_LOGS"] = os.path.join(tmp, "logs")

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("agent", os.path.join(here, "..", "src", "agent", "deploy-agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

deployed = []
gate = threading.Event()


def fake_run_deploy(project, trigger, commit="", message="", echo=False, on_start=None):
    gate.wait(5)  # hold the "deploy" open so we can test queueing behind it
    if on_start:
        on_start()
    deployed.append((project["name"], trigger, commit))
    return 0


agent.run_deploy = fake_run_deploy
server = agent.ThreadingHTTPServer(("127.0.0.1", 0), agent.Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % server.server_address[1]


def post(payload, event="push", secret=SECRET, path="/hooks/github", sig=None):
    body = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
    headers = {"Content-Type": "application/json", "X-GitHub-Event": event}
    if secret is not None:
        headers["X-Hub-Signature-256"] = sig or ("sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest())
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def push(repo="me/app", ref="refs/heads/master", after="abc1234def", **extra):
    return dict({"ref": ref, "after": after, "repository": {"full_name": repo}, "head_commit": {"message": "fix\nbody"}}, **extra)


failures = 0


def expect(name, got, want):
    global failures
    ok = got == want
    failures += 0 if ok else 1
    print("%s %s%s" % ("ok  " if ok else "FAIL", name, "" if ok else "  got %r want %r" % (got, want)))


with urllib.request.urlopen(BASE + "/hooks/health", timeout=5) as r:
    expect("health endpoint", json.loads(r.read())["ok"], True)

expect("missing signature rejected", post(push(), secret=None)[0], 401)
expect("wrong secret rejected", post(push(), secret="nope")[0], 401)
expect("malformed signature rejected", post(push(), sig="sha256=zz")[0], 401)
expect("wrong path is 404", post(push(), path="/hooks/other")[0], 404)
expect("ping answered", post({"zen": "hi"}, event="ping"), (200, {"ok": True, "pong": True}))
expect("non-push event ignored", post(push(), event="issues")[0], 200)
expect("other branch ignored", post(push(ref="refs/heads/dev")), (200, {"ok": True, "queued": [], "already_waiting": []}))
expect("unknown repo ignored", post(push(repo="me/nope"))[1]["queued"], [])
expect("branch delete ignored", post(push(deleted=True))[1].get("ignored"), "branch deleted")
expect("non-JSON body is 400", post(b"payload=%7B%7D")[0], 400)
expect("nothing deployed so far", deployed, [])

# Matching push: repo match is case-insensitive, the auto:false project is skipped.
expect("push queues deploy", post(push()), (202, {"ok": True, "queued": ["app"], "already_waiting": []}))
# A second push while the first is still waiting to start is coalesced.
expect("duplicate push coalesced", post(push(after="second")), (200, {"ok": True, "queued": [], "already_waiting": ["app"]}))
expect("other project independent", post(push(repo="me/other", ref="refs/heads/main"))[1]["queued"], ["other"])
gate.set()
time.sleep(0.5)
expect("deploys ran once each", sorted(deployed), [("app", "push", "abc1234def"), ("other", "push", "abc1234def")])
expect("can queue again afterwards", post(push(after="third"))[1]["queued"], ["app"])

server.shutdown()

# ---- .env set-up after a fresh clone
def checkout(files):
    d = tempfile.mkdtemp()
    for name, text in files.items():
        with open(os.path.join(d, name), "w", newline="") as f:
            f.write(text)
    return d


def env_of(d):
    p = os.path.join(d, ".env")
    if not os.path.exists(p):
        return None
    with open(p, newline="") as f:
        return f.read()


said = []
d = checkout({".env.example": "APP_NAME=demo\nAPP_PORT=8000\nDB_HOST=db\n"})
agent.prepare_env(d, 3001, said.append)
expect(".env copied from .env.example with APP_PORT replaced", env_of(d), "APP_NAME=demo\nAPP_PORT=3001\nDB_HOST=db\n")
expect(".env.example itself is untouched", open(os.path.join(d, ".env.example")).read(), "APP_NAME=demo\nAPP_PORT=8000\nDB_HOST=db\n")
expect("the deploy log says what was done", said, ["deploy-agent: created .env from .env.example\n", "deploy-agent: set APP_PORT=3001 in .env\n"])

d = checkout({".env.example": "APP_NAME=demo\n# APP_PORT=8000\nAPP_PORT_OTHER=1"})
agent.prepare_env(d, 3002, lambda _t: None)
expect("APP_PORT added when the example has none (comments and similar keys left alone)", env_of(d), "APP_NAME=demo\n# APP_PORT=8000\nAPP_PORT_OTHER=1\nAPP_PORT=3002\n")

d = checkout({".env.example": "A=1\r\nexport APP_PORT = 80\r\n"})
agent.prepare_env(d, 3003, lambda _t: None)
expect("line endings are kept", env_of(d), "A=1\r\nAPP_PORT=3003\r\n")

d = checkout({".env.example": "A=1\nAPP_PORT=80\n"})
agent.prepare_env(d, None, lambda _t: None)
expect("without a port the example is copied as it is", env_of(d), "A=1\nAPP_PORT=80\n")

d = checkout({})
agent.prepare_env(d, 3004, lambda _t: None)
expect("no example: .env is created with just the port", env_of(d), "APP_PORT=3004\n")

d = checkout({})
agent.prepare_env(d, None, lambda _t: None)
expect("no example and no port: nothing is created", env_of(d), None)

d = checkout({".env": "APP_PORT=1\n", ".env.example": "APP_PORT=2\n"})
agent.prepare_env(d, 3005, lambda _t: None)
expect("a .env that came with the repository is never touched", env_of(d), "APP_PORT=1\n")

# ---- "env NAME": the same set-up for a project that is already cloned
import shutil
import subprocess

if shutil.which("git"):
    def repo(files, track=()):
        d = checkout(files)
        subprocess.run(["git", "init", "-q"], cwd=d, check=True)
        for name in track:
            subprocess.run(["git", "add", name], cwd=d, check=True)
        return d

    d = repo({".env.example": "A=1\nAPP_PORT=80\n"})
    said = []
    expect("env: succeeds on a cloned project", agent.setup_env({"name": "p", "path": d, "app_port": 3010}, said.append), 0)
    expect("env: .env created from the example with the project's port", env_of(d), "A=1\nAPP_PORT=3010\n")

    d = repo({".env": "SECRET=keep\nAPP_PORT=80\n", ".env.example": "A=1\n"})
    agent.setup_env({"name": "p", "path": d, "app_port": 3011}, lambda _t: None)
    expect("env: an existing .env keeps its values, only APP_PORT changes", env_of(d), "SECRET=keep\nAPP_PORT=3011\n")

    d = repo({".env": "APP_PORT=80\n"}, track=[".env"])
    expect("env: refuses a .env that is tracked by git", agent.setup_env({"name": "p", "path": d, "app_port": 3012}, lambda _t: None), 1)
    expect("env: the tracked .env is untouched", env_of(d), "APP_PORT=80\n")

    d = checkout({".env.example": "A=1\n"})
    expect("env: refuses a folder that is not cloned yet", agent.setup_env({"name": "p", "path": d, "app_port": 3013}, lambda _t: None), 1)
    expect("env: and creates nothing there", env_of(d), None)
else:
    print("skip env NAME tests (git is not installed)")
print("\n%s" % ("ALL PASSED" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
