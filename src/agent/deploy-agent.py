#!/usr/bin/env python3
"""deploy-agent: receives GitHub push webhooks and runs a deploy command per project.

Python standard library only. Installed and configured by VPS Manager, but it has no
dependency on the desktop app: it keeps deploying on push whether or not the app is open.

  deploy-agent.py serve                      run the webhook server (systemd does this)
  deploy-agent.py run NAME [--trigger X]     deploy one project now, streaming output
  deploy-agent.py env NAME                   set up .env in a project that is already cloned
"""
import fcntl
import hashlib
import hmac
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.5.0"
# Server-wide GitHub key. /root/.ssh/config points github.com at it, so a plain
# "git pull" works in deploy commands (and in a root shell) with no extra setup.
SERVER_KEY = "/root/.ssh/github_deploy_ed25519"
CONFIG = os.environ.get("DEPLOY_AGENT_CONFIG", "/etc/deploy-agent/config.json")
LOG_DIR = os.environ.get("DEPLOY_AGENT_LOGS", "/var/log/deploy-agent")
MAX_BODY = 5 * 1024 * 1024
# Who owns a project's files. The agent clones and pulls as root; afterwards it hands what it
# wrote to this user (a project's "owner" setting overrides it). "user" alone means user:user's group.
DEFAULT_OWNER = "matt:matt"
KEEP_LOGS = 30


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def find_project(cfg, name):
    for p in cfg.get("projects", []):
        if p.get("name") == name:
            return p
    return None


def default_command(project):
    branch = shlex.quote(project.get("branch") or "master")
    return "git pull --ff-only origin %s && docker compose up -d --build --remove-orphans" % branch


def deploy_env(project):
    env = dict(os.environ)
    env.setdefault("HOME", "/root")
    env.update({
        "GIT_TERMINAL_PROMPT": "0",
        # The agent runs as root; repos may be owned by another user.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "safe.directory",
        "GIT_CONFIG_VALUE_0": "*",
        "DEPLOY_PROJECT": project["name"],
        "DEPLOY_BRANCH": project.get("branch") or "master",
    })
    key = project.get("ssh_key")
    if key and os.path.isfile(key):
        env["GIT_SSH_COMMAND"] = "ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" % shlex.quote(key)
    return env


def set_env_value(env_file, key, value):
    """Set KEY=value in a dotenv file: the existing line is replaced, otherwise one is added."""
    text = ""
    if os.path.isfile(env_file):
        with open(env_file, encoding="utf-8", errors="surrogateescape", newline="") as f:
            text = f.read()
    line = "%s=%s" % (key, value)
    pattern = re.compile(r"^[ \t]*(?:export[ \t]+)?%s[ \t]*=[^\r\n]*" % re.escape(key), re.M)
    if pattern.search(text):
        text = pattern.sub(lambda _m: line, text, count=1)
    else:
        eol = "\r\n" if "\r\n" in text else "\n"
        if text and not text.endswith(("\n", "\r")):
            text += eol
        text += line + eol
    with open(env_file, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
        f.write(text)


def prepare_env(path, port, emit):
    """Right after a fresh clone: create .env from .env.example and set APP_PORT to the site's port.

    A .env that came with the repository is left alone: editing a tracked file would block later pulls.
    """
    env_file = os.path.join(path, ".env")
    example = os.path.join(path, ".env.example")
    if os.path.lexists(env_file):
        emit("deploy-agent: the repository has its own .env; left as it is\n")
        return
    if os.path.isfile(example):
        shutil.copyfile(example, env_file)
        emit("deploy-agent: created .env from .env.example\n")
    elif not port:
        return
    if port:
        set_env_value(env_file, "APP_PORT", str(int(port)))
        emit("deploy-agent: set APP_PORT=%d in .env\n" % int(port))


def setup_env(project, emit):
    """For a checkout that already exists: create .env from .env.example if there is none, and set
    APP_PORT to the project's port. An existing .env keeps everything else it has."""
    path = project["path"]
    port = project.get("app_port")
    if not os.path.isdir(os.path.join(path, ".git")):
        emit("%s is not cloned yet; .env is set up automatically on the first deploy\n" % project["name"])
        return 1
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", ".env"], cwd=path, env=deploy_env(project),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if tracked:
        emit(".env is part of the repository; changing it would block later pulls, so it was left as it is\n")
        return 1
    env_file = os.path.join(path, ".env")
    example = os.path.join(path, ".env.example")
    if os.path.lexists(env_file):
        emit(".env already exists; its other values are kept\n")
    elif os.path.isfile(example):
        shutil.copyfile(example, env_file)
        emit("created .env from .env.example\n")
    elif not port:
        emit("nothing to do: the repository has no .env.example and the project has no port\n")
        return 0
    if port:
        set_env_value(env_file, "APP_PORT", str(int(port)))
        emit("set APP_PORT=%d in .env\n" % int(port))
    give_to_owner(project, emit)
    return 0


def resolve_owner(project):
    """(uid, gid, "user:group") for the project's owner, or None if that user does not exist here."""
    import grp
    import pwd
    spec = project.get("owner") or DEFAULT_OWNER
    user, _, group = spec.partition(":")
    try:
        pw = pwd.getpwnam(user)
        gid = grp.getgrnam(group).gr_gid if group else pw.pw_gid
    except KeyError:
        return None
    return pw.pw_uid, gid, spec


def _chown(p, owner, only_root):
    try:
        if only_root and os.lstat(p).st_uid != 0:
            return
        os.lchown(p, owner[0], owner[1])
    except OSError:
        pass


def give_to_owner(project, emit, created=(), whole=False):
    """Hand files the agent (root) wrote to the project's owner.

    whole: everything under the checkout (right after a fresh clone). Otherwise only root-owned
    entries in .git, git-tracked files (and their folders) and .env - what a "git pull" writes -
    so data folders that containers own (a database volume, say) are never touched.
    """
    if os.name != "posix":  # no users to hand files to (only when testing off Linux)
        return
    owner = resolve_owner(project)
    if owner is None:
        emit("deploy-agent: user %s does not exist on this server; files stay owned by root\n"
             % (project.get("owner") or DEFAULT_OWNER).split(":")[0])
        return
    path = project["path"]
    for d in created:
        _chown(d, owner, False)
    if whole:
        _chown(path, owner, False)
        for root, dirs, files in os.walk(path):
            for n in dirs + files:
                _chown(os.path.join(root, n), owner, False)
        emit("deploy-agent: %s is now owned by %s\n" % (path, owner[2]))
        return
    _chown(path, owner, True)
    for root, dirs, files in os.walk(os.path.join(path, ".git")):
        _chown(root, owner, True)
        for n in files:
            _chown(os.path.join(root, n), owner, True)
    _chown(os.path.join(path, ".env"), owner, True)
    try:
        r = subprocess.run(["git", "ls-files", "-z"], cwd=path, env=deploy_env(project),
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        tracked = [f for f in r.stdout.decode("utf-8", "surrogateescape").split("\0") if f]
    except Exception:  # noqa: BLE001
        tracked = []
    seen = set()
    for f in tracked:
        _chown(os.path.join(path, f), owner, True)
        d = os.path.dirname(f)
        while d and d not in seen:
            seen.add(d)
            _chown(os.path.join(path, d), owner, True)
            d = os.path.dirname(d)


def missing_dirs(path):
    """The folders os.makedirs(path) would create, outermost first."""
    out = []
    path = os.path.abspath(path)
    while path and path != "/" and not os.path.exists(path):
        out.append(path)
        path = os.path.dirname(path)
    return out[::-1]


def head_commit(project):
    """(sha, subject) of the checkout's HEAD, or ("", "") when there is none."""
    try:
        r = subprocess.run(["git", "log", "-1", "--format=%H%n%s"], cwd=project["path"], env=deploy_env(project),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=10)
        if r.returncode != 0:
            return "", ""
        sha, _, subject = r.stdout.partition("\n")
        return sha.strip(), subject.strip()[:200]
    except Exception:  # noqa: BLE001
        return "", ""


def run_deploy(project, trigger, commit="", message="", echo=False, on_start=None):
    """Run one deploy. Deploys of the same project are serialised with a file lock."""
    name = project["name"]
    pdir = os.path.join(LOG_DIR, name)
    os.makedirs(pdir, exist_ok=True)
    lock = open(os.path.join(pdir, ".lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        if on_start:
            project = on_start() or project
        started = time.time()
        log_path = os.path.join(pdir, time.strftime("%Y%m%d-%H%M%S", time.localtime(started)) + ".log")
        code = 1
        with open(log_path, "w") as log:
            def emit(text):
                log.write(text)
                log.flush()
                if echo:
                    sys.stdout.write(text)
                    sys.stdout.flush()

            def step(cmd, cwd, env):
                emit("$ %s\n" % cmd)
                proc = subprocess.Popen(["bash", "-c", cmd], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
                for line in proc.stdout:
                    emit(line)
                return proc.wait()

            try:
                path = project["path"]
                branch = project.get("branch") or "master"
                env = deploy_env(project)
                emit("[%s] deploying %s (%s, trigger: %s%s)\n" % (
                    time.strftime("%Y-%m-%d %H:%M:%S"), name, branch, trigger, (" " + commit[:8]) if commit else ""))
                code = 0
                if not os.path.isdir(os.path.join(path, ".git")):
                    use_ssh = "GIT_SSH_COMMAND" in env or os.path.isfile(SERVER_KEY)
                    fmt = "git@github.com:%s.git" if use_ssh else "https://github.com/%s.git"
                    parent = os.path.dirname(path.rstrip("/")) or "/"
                    created = missing_dirs(parent)
                    os.makedirs(parent, exist_ok=True)
                    code = step("git clone --branch %s %s %s" % (
                        shlex.quote(branch), shlex.quote(fmt % project["repo"]), shlex.quote(path)), "/", env)
                    if code == 0:
                        prepare_env(path, project.get("app_port"), emit)
                        give_to_owner(project, emit, created=created, whole=True)
                if code == 0 and project.get("ssh_key") and "GIT_SSH_COMMAND" in env:
                    # Record the per-project key in the checkout, so a manual "git pull" there uses it too.
                    subprocess.run(["git", "config", "core.sshCommand", env["GIT_SSH_COMMAND"]], cwd=path, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if code == 0:
                    code = step(project.get("command") or default_command(project), path, env)
                    # The command ran as root: a "git pull" in it leaves root-owned files behind.
                    give_to_owner(project, emit)
            except Exception as e:  # noqa: BLE001 - report anything to the log
                emit("deploy-agent error: %s\n" % e)
                code = 1
            # "Deploy now" has no push payload: record the commit the checkout is on, so the
            # history and the log say which build this was.
            if not commit:
                commit, subject = head_commit(project)
                message = message or subject
            if commit:
                emit("\ndeployed commit %s%s\n" % (commit[:8], (" " + message) if message else ""))
            finished = time.time()
            emit("\n[%s] %s (exit code %d, %ds)\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), "SUCCESS" if code == 0 else "FAILED", code, finished - started))

        with open(os.path.join(LOG_DIR, "history.jsonl"), "a") as h:
            h.write(json.dumps({"project": name, "trigger": trigger, "commit": commit, "message": message,
                                "started": started, "finished": finished, "code": code, "log": log_path}) + "\n")
        logs = sorted(f for f in os.listdir(pdir) if f.endswith(".log"))
        for old in logs[:-KEEP_LOGS]:
            try:
                os.remove(os.path.join(pdir, old))
            except OSError:
                pass
        return code
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


# One deploy may run and one may wait per project. Extra pushes that arrive while one is
# already waiting are dropped: the waiting deploy pulls the newest commit anyway.
_waiting = set()
_waiting_lock = threading.Lock()


def queue_deploy(project, commit, message):
    name = project["name"]
    with _waiting_lock:
        if name in _waiting:
            return False
        _waiting.add(name)

    def on_start():
        with _waiting_lock:
            _waiting.discard(name)
        try:
            return find_project(load_config(), name)
        except Exception:  # noqa: BLE001
            return None

    def work():
        try:
            run_deploy(project, "push", commit, message, on_start=on_start)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("deploy of %s crashed: %s\n" % (name, e))
            with _waiting_lock:
                _waiting.discard(name)

    threading.Thread(target=work, daemon=True).start()
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "deploy-agent/" + VERSION
    timeout = 30

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.headers.get("X-Forwarded-For", self.client_address[0]) if self.headers else "-", fmt % args))

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/hooks/health":
            return self.reply(200, {"ok": True, "version": VERSION})
        return self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/hooks/github":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411, {"error": "length required"})
        if length < 0 or length > MAX_BODY:
            return self.reply(413, {"error": "payload too large"})
        body = self.rfile.read(length)

        try:
            cfg = load_config()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("cannot read config: %s\n" % e)
            return self.reply(500, {"error": "agent is misconfigured"})

        # Authenticate before looking at the payload at all.
        secret = cfg.get("secret") or ""
        want = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        got = self.headers.get("X-Hub-Signature-256", "")
        if not secret or not hmac.compare_digest(got.encode(), want.encode()):
            return self.reply(401, {"error": "bad signature"})

        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            return self.reply(200, {"ok": True, "pong": True})
        if event != "push":
            return self.reply(200, {"ok": True, "ignored": "event " + event})
        try:
            payload = json.loads(body)
            repo = payload["repository"]["full_name"].lower()
            ref = payload.get("ref", "")
        except Exception:  # noqa: BLE001
            return self.reply(400, {"error": "expected a JSON push payload (set the webhook content type to application/json)"})
        if payload.get("deleted"):
            return self.reply(200, {"ok": True, "ignored": "branch deleted"})

        head = payload.get("head_commit") or {}
        commit = payload.get("after", "")
        message = (head.get("message") or "").split("\n")[0][:200]
        queued, skipped = [], []
        for p in cfg.get("projects", []):
            if not p.get("auto", True) or (p.get("repo") or "").lower() != repo:
                continue
            if ref != "refs/heads/" + (p.get("branch") or "master"):
                continue
            (queued if queue_deploy(p, commit, message) else skipped).append(p["name"])
        return self.reply(202 if queued else 200, {"ok": True, "queued": queued, "already_waiting": skipped})


def main(argv):
    if len(argv) >= 2 and argv[1] == "serve":
        cfg = load_config()
        os.makedirs(LOG_DIR, exist_ok=True)
        addr = (cfg.get("listen", "127.0.0.1"), int(cfg.get("port", 9321)))
        server = ThreadingHTTPServer(addr, Handler)
        server.daemon_threads = True
        sys.stderr.write("deploy-agent %s listening on %s:%d\n" % (VERSION, addr[0], addr[1]))
        server.serve_forever()
    elif len(argv) >= 3 and argv[1] == "run":
        trigger = argv[argv.index("--trigger") + 1] if "--trigger" in argv[3:] and len(argv) > argv.index("--trigger") + 1 else "manual"
        project = find_project(load_config(), argv[2])
        if not project:
            sys.stderr.write("no such project: %s\n" % argv[2])
            return 2
        return run_deploy(project, trigger, echo=True)
    elif len(argv) >= 3 and argv[1] == "env":
        project = find_project(load_config(), argv[2])
        if not project:
            sys.stderr.write("no such project: %s\n" % argv[2])
            return 2
        return setup_env(project, sys.stdout.write)
    elif len(argv) >= 2 and argv[1] == "version":
        print(VERSION)
    else:
        sys.stderr.write(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
