#!/usr/bin/env python3
"""GroupDesk macOS native standalone installer, process manager, and encrypted recovery utility.

No Docker required. Runs an isolated PostgreSQL 16 cluster and Node >=22.13 runtime
bound to 127.0.0.1 with strict file permissions and zero shared production state.
"""
import argparse
import datetime
import getpass
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

os.umask(0o077)
BUNDLE = Path(__file__).resolve().parent.parent


def fail(message):
    raise RuntimeError(message)


def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, **kw)


def capture(args, **kw):
    return subprocess.check_output([str(a) for a in args], text=True, **kw).strip()


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def env_read(path):
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            k, v = line.split("=", 1)
            values[k] = v
    return values


def env_write(path, values):
    if any("\n" in str(v) or "\r" in str(v) for v in values.values()):
        fail("Configuration contains a newline")
    path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    path.chmod(0o600)


def json_write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def extract(tar, dest, prefix=""):
    """Safely extract tar archive members, rejecting traversal, absolute paths, links, and devices."""
    for m in tar:
        if prefix and not (m.name == prefix.rstrip("/") or m.name.startswith(prefix)):
            continue
        rel = m.name[len(prefix):] if prefix else m.name
        if not rel:
            continue
        parts = Path(rel).parts
        if Path(rel).is_absolute() or ".." in parts or m.issym() or m.islnk() or not (m.isfile() or m.isdir()):
            fail("Unsafe recovery archive member")
        path = dest / rel
        if any(p.is_symlink() for p in [path, *path.parents]):
            fail("Recovery path contains a symlink")
        if m.isdir():
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        else:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tar.extractfile(m) as source, path.open("xb") as f:
                shutil.copyfileobj(source, f)
            path.chmod(m.mode & 0o777)


def manifest(root):
    if any(p.is_symlink() for p in root.rglob("*")):
        fail("Symlinks are not supported in standalone backup payloads")
    return {
        str(p.relative_to(root)): {"sha256": sha(p), "bytes": p.stat().st_size}
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != "MANIFEST.json"
    }


def verify(root):
    expected = json.loads((root / "MANIFEST.json").read_text())
    if expected != manifest(root):
        fail("Backup file manifest differs")


def gpg(args, key):
    if not shutil.which("gpg"):
        fail("Install GnuPG first (for example: brew install gnupg), then retry")
    if key:
        p = Path(key).resolve()
        if not p.is_file() or p.stat().st_mode & 0o077:
            fail("Passphrase file must be private (chmod 600)")
        return [
            "gpg",
            "--batch",
            "--pinentry-mode",
            "loopback",
            "--no-symkey-cache",
            "--passphrase-file",
            str(p),
            *args,
        ]
    return ["gpg", *args]


def parse_node_version(text):
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", text.strip())
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def find_node(explicit=None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    env_bin = os.environ.get("GROUPDESK_NODE_BIN")
    if env_bin:
        candidates.append(Path(env_bin))
    candidates.append(BUNDLE / "runtime/node/bin/node")
    which_node = shutil.which("node")
    if which_node:
        candidates.append(Path(which_node))
    nvm_dir = Path.home() / ".nvm/versions/node"
    if nvm_dir.is_dir():
        for entry in sorted(nvm_dir.iterdir(), reverse=True):
            candidates.append(entry / "bin/node")
    for cand in candidates:
        if cand.is_file() and os.access(cand, os.X_OK):
            try:
                ver_str = capture([cand, "-v"])
                if parse_node_version(ver_str) >= (22, 13, 0):
                    return cand.resolve(), ver_str
            except (subprocess.CalledProcessError, OSError):
                continue
    fail("Node.js >= 22.13 is required. Use the bundled macOS package or install Node 22+.")


def find_postgres(explicit_bin_dir=None):
    candidates = []
    if explicit_bin_dir:
        candidates.append(Path(explicit_bin_dir))
    env_bin = os.environ.get("GROUPDESK_POSTGRES_BIN")
    if env_bin:
        candidates.append(Path(env_bin))
    candidates.append(BUNDLE / "runtime/postgres/bin")
    candidates.append(Path("/opt/homebrew/opt/postgresql@16/bin"))
    candidates.append(Path("/usr/local/opt/postgresql@16/bin"))
    which_initdb = shutil.which("initdb")
    if which_initdb:
        candidates.append(Path(which_initdb).resolve().parent)

    required = ["initdb", "pg_ctl", "postgres", "psql", "pg_isready", "createdb", "pg_dump", "pg_dumpall", "pg_restore"]
    for bin_dir in candidates:
        if bin_dir.is_dir() and all((bin_dir / tool).is_file() for tool in required):
            bin_dir = bin_dir.resolve()
            prefix = bin_dir.parent
            share_dir = prefix / "share/postgresql@16"
            if not share_dir.is_dir():
                share_dir = prefix / "share/postgresql"
            if not share_dir.is_dir():
                share_dir = None
            pkglib_dir = prefix / "lib/postgresql"
            if not pkglib_dir.is_dir():
                pkglib_dir = None
            ver = capture([bin_dir / "postgres", "--version"])
            return {
                "bin": bin_dir,
                "share": share_dir,
                "pkglib": pkglib_dir,
                "version": ver,
                "bundled": str(bin_dir).startswith(str(BUNDLE.resolve())),
            }
    fail("PostgreSQL 16 binaries not found. Use the bundled macOS package or install postgresql@16.")


def port_available(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def pick_pg_port(app_port, requested=0):
    if requested:
        if not 1024 <= requested <= 65535 or requested == app_port:
            fail("Choose a PostgreSQL port between 1024 and 65535 different from app port")
        if not port_available(requested):
            fail(f"PostgreSQL port 127.0.0.1:{requested} is already in use")
        return requested
    base = 54329 + (app_port % 1000)
    for candidate in range(base, base + 200):
        if candidate <= 65535 and candidate != app_port and port_available(candidate):
            return candidate
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_pid(path):
    if not path.is_file():
        return None
    try:
        pid = int(path.read_text().strip())
    except ValueError:
        return None
    if pid > 1 and pid_alive(pid):
        return pid
    return None


def http_health_ok(port, timeout=2.0):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/health", timeout=timeout) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


class Instance:
    def __init__(self, path, node_bin=None, pg_bin=None):
        self.root = Path(path).resolve()
        self.config = self.root / "config"
        self.run_dir = self.root / "run"
        self.log_dir = self.root / "logs"
        self.meta = json.loads((self.root / "instance.json").read_text())
        if not re.fullmatch(r"gd-[a-z0-9][a-z0-9-]{0,36}", self.meta["project"]):
            fail("Not a standalone project")
        if self.meta.get("mode") != "macos-native":
            fail("Instance is not a macOS native standalone instance")
        self.runtime_env = env_read(self.config / "runtime.env")
        self.appenv = env_read(self.config / "app.env")
        if self.runtime_env["INSTANCE_ROOT"] != str(self.root):
            fail("Instance moved: review paths before use")
        self.app_port = int(self.runtime_env["APP_PORT"])
        self.pg_port = int(self.runtime_env["PG_PORT"])
        self.node_bin, self.node_version = find_node(node_bin)
        self.pg_info = find_postgres(pg_bin)
        self.pg_data = self.root / "data/postgres"
        self.files_dir = self.root / "data/files"

    def pg_env(self):
        env = os.environ.copy()
        env["PGHOST"] = "127.0.0.1"
        env["PGPORT"] = str(self.pg_port)
        env["PGUSER"] = self.runtime_env["BOOTSTRAP_USER"]
        env["PGPASSWORD"] = self.runtime_env["BOOTSTRAP_PASSWORD"]
        env["LC_ALL"] = "C"
        return env

    def pg_tool(self, name):
        return str(self.pg_info["bin"] / name)

    def pg_running(self):
        if not (self.pg_data / "PG_VERSION").is_file():
            return False
        res = subprocess.run(
            [self.pg_tool("pg_ctl"), "-D", str(self.pg_data), "status"],
            env=self.pg_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return res.returncode == 0

    def ensure_pg_cluster(self):
        if (self.pg_data / "PG_VERSION").is_file():
            return
        self.pg_data.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="gd-pginit-") as tmp:
            pwfile = Path(tmp) / "pw"
            pwfile.write_text(self.runtime_env["BOOTSTRAP_PASSWORD"] + "\n")
            pwfile.chmod(0o600)
            cmd = [
                self.pg_tool("initdb"),
                "-D",
                str(self.pg_data),
                "--username",
                self.runtime_env["BOOTSTRAP_USER"],
                "--pwfile",
                str(pwfile),
                "--auth-host=scram-sha-256",
                "--auth-local=scram-sha-256",
                "--encoding=UTF8",
                "--locale=C",
            ]
            if self.pg_info["share"] is not None:
                cmd.extend(["-L", str(self.pg_info["share"])])
            run(cmd, env=self.pg_env(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        conf_lines = [
            "",
            "# GroupDesk standalone isolated PostgreSQL settings",
            "listen_addresses = '127.0.0.1'",
            f"port = {self.pg_port}",
            "unix_socket_directories = ''",
            "logging_collector = off",
            "max_connections = 64",
        ]
        if self.pg_info["pkglib"] is not None:
            conf_lines.append(f"dynamic_library_path = '{self.pg_info['pkglib']}:$libdir'")
        conf_path = self.pg_data / "postgresql.conf"
        with conf_path.open("a") as f:
            f.write("\n".join(conf_lines) + "\n")

    def pg_start(self):
        self.ensure_pg_cluster()
        self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.pg_running():
            if not port_available(self.pg_port):
                fail(f"PostgreSQL port 127.0.0.1:{self.pg_port} is already in use")
            pg_log = self.log_dir / "postgres.log"
            run(
                [
                    self.pg_tool("pg_ctl"),
                    "-D",
                    str(self.pg_data),
                    "-l",
                    str(pg_log),
                    "-w",
                    "-t",
                    "30",
                    "start",
                ],
                env=self.pg_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            if pg_log.exists():
                pg_log.chmod(0o600)
        for _ in range(30):
            res = subprocess.run(
                [self.pg_tool("pg_isready"), "-h", "127.0.0.1", "-p", str(self.pg_port), "-U", self.runtime_env["BOOTSTRAP_USER"]],
                env=self.pg_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if res.returncode == 0:
                return
            time.sleep(0.5)
        fail("PostgreSQL did not become ready; inspect logs/postgres.log")

    def pg_stop(self):
        if self.pg_running():
            run(
                [self.pg_tool("pg_ctl"), "-D", str(self.pg_data), "-m", "fast", "-w", "-t", "30", "stop"],
                env=self.pg_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def sql(self, db, statement):
        return capture(
            [
                self.pg_tool("psql"),
                "-X",
                "-h",
                "127.0.0.1",
                "-p",
                str(self.pg_port),
                "-U",
                self.runtime_env["BOOTSTRAP_USER"],
                "-d",
                db,
                "-At",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                statement,
            ],
            env=self.pg_env(),
        )

    def sql_stdin(self, db, sql_bytes):
        return run(
            [
                self.pg_tool("psql"),
                "-X",
                "-h",
                "127.0.0.1",
                "-p",
                str(self.pg_port),
                "-U",
                self.runtime_env["BOOTSTRAP_USER"],
                "-d",
                db,
                "-v",
                "ON_ERROR_STOP=1",
            ],
            env=self.pg_env(),
            input=sql_bytes,
            stdout=subprocess.DEVNULL,
        )

    def fingerprints(self, db):
        result = {}
        tables = self.sql(db, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        for table in tables:
            if not re.fullmatch(r"[a-z_0-9]+", table):
                fail("Unexpected SQL identifier")
            query = (
                "SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),'' "
                "ORDER BY md5(row_to_json(t)::text)),'')) FROM public.\"" + table + "\" t"
            )
            rows, digest = self.sql(db, query).split("|")
            result[table] = {"rows": int(rows), "row_digest": digest}
        return result

    def node_env(self):
        env = os.environ.copy()
        env.update(self.appenv)
        env["NODE_ENV"] = "production"
        env["DATA_DIR"] = str(self.files_dir)
        env["PORT"] = str(self.app_port)
        env.setdefault("HOST", "127.0.0.1")
        env["GROUPDESK_SUMMARY_LIBRARY"] = "generic"
        env["PATH"] = f"{self.node_bin.parent}:{self.pg_info['bin']}:{env.get('PATH', '/usr/bin:/bin')}"
        if self.meta.get("isolated"):
            env["HTTP_PROXY"] = "http://127.0.0.1:1"
            env["HTTPS_PROXY"] = "http://127.0.0.1:1"
            env["ALL_PROXY"] = "http://127.0.0.1:1"
            env["NO_PROXY"] = "127.0.0.1,localhost"
        return env

    def runtime(self, *args, stdin=None):
        return run(
            [self.node_bin, *args],
            cwd=str(BUNDLE),
            env=self.node_env(),
            stdin=stdin,
            stdout=subprocess.DEVNULL,
        )

    def pid_file(self, service):
        return self.run_dir / f"{service}.pid"

    def log_file(self, service):
        return self.log_dir / f"{service}.log"

    def service_pid(self, service):
        return read_pid(self.pid_file(service))

    def start_node_service(self, service, script):
        existing = self.service_pid(service)
        if existing:
            return existing
        if service == "app" and not port_available(self.app_port):
            fail(f"App port 127.0.0.1:{self.app_port} is already in use")
        self.run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.files_dir / "uploads").mkdir(parents=True, exist_ok=True, mode=0o700)
        log_path = self.log_file(service)
        fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            proc = subprocess.Popen(
                [str(self.node_bin), "--import", "tsx", script],
                cwd=str(BUNDLE),
                env=self.node_env(),
                stdin=subprocess.DEVNULL,
                stdout=fd,
                stderr=fd,
                start_new_session=True,
            )
        finally:
            os.close(fd)
        pfile = self.pid_file(service)
        pfile.write_text(f"{proc.pid}\n")
        pfile.chmod(0o600)
        return proc.pid

    def stop_node_service(self, service, timeout=15.0):
        pid = self.service_pid(service)
        pfile = self.pid_file(service)
        if not pid:
            if pfile.exists():
                pfile.unlink()
            return False
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not pid_alive(pid):
                break
            time.sleep(0.2)
        if pid_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            time.sleep(0.3)
        if pfile.exists():
            pfile.unlink()
        return True

    def wait_health(self, pid):
        for _ in range(90):
            if not pid_alive(pid):
                fail(f"Application exited during startup; inspect {self.log_file('app')}")
            if http_health_ok(self.app_port):
                return
            time.sleep(1)
        fail(f"Application is not healthy; inspect {self.log_file('app')}")


def initialize(a):
    find_node(a.node_bin)
    find_postgres(a.postgres_bin)
    root = Path(a.target).resolve()
    if not a.admin.strip() or len(a.admin) > 80:
        fail("Administrator name must contain 1-80 characters")
    if root.exists():
        fail("Choose a new directory; existing directories are never overwritten")
    if not re.fullmatch(r"gd-[a-z0-9][a-z0-9-]{0,36}", a.project):
        fail("Project must start with gd- and contain lowercase letters/numbers/hyphens")
    if not 1024 <= a.port <= 65535:
        fail("Choose a port between 1024 and 65535")
    if not port_available(a.port):
        fail(f"Port 127.0.0.1:{a.port} is already in use")
    pg_port = pick_pg_port(a.port, a.pg_port)
    origin_str = a.origin or f"http://localhost:{a.port}"
    origin = urlsplit(origin_str)
    if (
        origin.scheme not in {"http", "https"}
        or not origin.hostname
        or origin.username
        or origin.password
        or origin.path not in {"", "/"}
        or origin.query
        or origin.fragment
    ):
        fail("Use a site origin")
    if origin.scheme == "http" and origin.hostname not in {"localhost", "127.0.0.1", "::1"}:
        fail("Public access requires an HTTPS origin and a separately configured TLS proxy")

    if a.admin_password_file:
        p = Path(a.admin_password_file)
        if p.stat().st_mode & 0o077:
            fail("Admin password file must be private (chmod 600)")
        password = p.read_text().rstrip("\r\n")
    else:
        password = getpass.getpass("Set the first administrator password (16+ characters): ")
        if password != getpass.getpass("Repeat password: "):
            fail("Passwords differ")
    if len(password) < 16:
        fail("Administrator password requires 16+ characters")

    root.parent.mkdir(parents=True, exist_ok=True)
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    config = root / "config"
    config.mkdir(mode=0o700)
    (root / "data/files").mkdir(parents=True, mode=0o700)
    (root / "data/postgres").mkdir(mode=0o700)
    (root / "run").mkdir(mode=0o700)
    (root / "logs").mkdir(mode=0o700)

    pgpass = secrets.token_hex(32)
    env_write(
        config / "app.env",
        {
            "HOST": "127.0.0.1",
            "PORT": str(a.port),
            "DATA_DIR": str(root / "data/files"),
            "DATABASE_URL": f"postgres://groupdesk:{pgpass}@127.0.0.1:{pg_port}/groupdesk",
            "ADMIN_USERNAME": a.admin,
            "ADMIN_PASSWORD": password,
            "BOT_API_TOKEN": secrets.token_hex(32),
            "MODEL_ENCRYPTION_KEY": secrets.token_hex(32),
            "COOKIE_SECURE": str(origin.scheme == "https").lower(),
            "PUBLIC_ORIGIN": origin_str,
            "INSTANCE_LABEL": a.project,
            "GROUPDESK_SUMMARY_LIBRARY": "generic",
        },
    )
    env_write(
        config / "runtime.env",
        {
            "INSTANCE_ROOT": str(root),
            "APP_PORT": str(a.port),
            "PG_PORT": str(pg_port),
            "BOOTSTRAP_USER": "gdboot_" + secrets.token_hex(6),
            "BOOTSTRAP_PASSWORD": secrets.token_hex(32),
            "ISOLATED": str(a.isolated).lower(),
        },
    )
    json_write(
        root / "instance.json",
        {
            "format": 1,
            "mode": "macos-native",
            "project": a.project,
            "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "isolated": a.isolated,
            "app_port": a.port,
            "pg_port": pg_port,
        },
    )
    print(f"Private configuration saved: {root}")
    print(f"App endpoint: {origin_str} (private PostgreSQL on 127.0.0.1:{pg_port})")
    print("No AI key, OAuth identity or WeChat data was imported. Next: up")


def up(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    if a.workers and i.meta["isolated"]:
        fail("Workers cannot be enabled in an isolated instance")
    i.pg_start()
    if i.sql("postgres", "SELECT count(*) FROM pg_database WHERE datname='groupdesk'") == "0":
        password = urlsplit(i.appenv["DATABASE_URL"]).password
        if not re.fullmatch(r"[a-f0-9]{64}", password or ""):
            fail("Unexpected initial database password")
        sql = f"CREATE ROLE groupdesk LOGIN SUPERUSER PASSWORD '{password}';CREATE DATABASE groupdesk OWNER groupdesk;\n".encode()
        i.sql_stdin("postgres", sql)
    app_pid = i.start_node_service("app", "server/index.ts")
    i.wait_health(app_pid)
    if a.workers:
        i.start_node_service("worker", "server/worker.ts")
        i.start_node_service("interaction-worker", "server/interactions/templates.ts")
    print(f"Healthy: {i.appenv['PUBLIC_ORIGIN']} ; workers {'enabled' if a.workers else 'not started'}")


def down(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    for svc in ["interaction-worker", "worker", "app"]:
        i.stop_node_service(svc)
    i.pg_stop()
    print(f"Stopped: {i.root}")


def status(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    info = {
        "project": i.meta["project"],
        "target": str(i.root),
        "origin": i.appenv["PUBLIC_ORIGIN"],
        "app_port": i.app_port,
        "pg_port": i.pg_port,
        "isolated": bool(i.meta.get("isolated")),
        "postgres": "running" if i.pg_running() else "stopped",
        "app": "running" if i.service_pid("app") else "stopped",
        "worker": "running" if i.service_pid("worker") else "stopped",
        "interaction_worker": "running" if i.service_pid("interaction-worker") else "stopped",
        "health": http_health_ok(i.app_port),
        "node": i.node_version,
        "postgres_version": i.pg_info["version"],
    }
    if a.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
    else:
        for k, v in info.items():
            print(f"{k}: {v}")


def logs(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    names = ["app", "postgres", "worker", "interaction-worker"] if a.service == "all" else [a.service]
    for name in names:
        p = i.log_file(name)
        print(f"=== {name} ({p}) ===")
        if not p.is_file():
            print("(no log yet)")
            continue
        lines = p.read_text(errors="replace").splitlines()
        for line in lines[-a.lines:]:
            print(line)


def backup(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    dest = Path(a.output).resolve()
    if dest.exists():
        fail("Backup destination already exists")
    gpg([], a.passphrase_file)
    running = []
    for svc in ["interaction-worker", "worker", "app"]:
        if i.service_pid(svc):
            running.append(svc)
    i.pg_start()
    with tempfile.TemporaryDirectory(prefix="groupdesk-backup-") as temp:
        root = Path(temp) / "backup"
        root.mkdir()
        (root / "databases").mkdir()
        try:
            for svc in running:
                i.stop_node_service(svc)
            for table, condition in [
                ("managed_runtime_jobs", "status IN ('preparing','executing')"),
                ("managed_bot_purges", "status='processing'"),
                ("managed_deletion_cleanups", "status='processing'"),
            ]:
                if (
                    i.sql("groupdesk", f"SELECT to_regclass('public.{table}') IS NOT NULL") == "t"
                    and i.sql("groupdesk", f"SELECT count(*) FROM {table} WHERE {condition}") != "0"
                ):
                    fail("Maintenance still active: reconcile before backup")
            dbs = []
            fingerprints = {}
            db_rows = i.sql(
                "postgres",
                "SELECT datname,pg_get_userbyid(datdba) FROM pg_database WHERE NOT datistemplate AND datname<>'postgres' ORDER BY datname",
            ).splitlines()
            for line in db_rows:
                db, owner = line.split("|")
                if not re.fullmatch(r"groupdesk|gdb_[a-f0-9]{32}", db):
                    fail("Unexpected database in instance")
                dbs.append({"name": db, "owner": owner})
                with (root / "databases" / f"{db}.dump").open("wb") as f:
                    run(
                        [
                            i.pg_tool("pg_dump"),
                            "-h",
                            "127.0.0.1",
                            "-p",
                            str(i.pg_port),
                            "-U",
                            i.runtime_env["BOOTSTRAP_USER"],
                            "-d",
                            db,
                            "-Fc",
                        ],
                        env=i.pg_env(),
                        stdout=f,
                    )
                fingerprints[db] = i.fingerprints(db)
            with (root / "roles.sql").open("wb") as f:
                run(
                    [
                        i.pg_tool("pg_dumpall"),
                        "-h",
                        "127.0.0.1",
                        "-p",
                        str(i.pg_port),
                        "-U",
                        i.runtime_env["BOOTSTRAP_USER"],
                        "--globals-only",
                    ],
                    env=i.pg_env(),
                    stdout=f,
                )
            json_write(root / "databases.json", dbs)
            json_write(root / "database-fingerprints.json", fingerprints)
            shutil.copytree(i.files_dir, root / "files", symlinks=True)
            shutil.copy2(i.config / "app.env", root / "app.env")
            json_write(
                root / "metadata.json",
                {
                    "format": 1,
                    "mode": "macos-native",
                    "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "project": i.meta["project"],
                    "node_version": i.node_version,
                    "postgres_version": i.pg_info["version"],
                    "scope": "site databases, files and matching secrets; WeChat runtime backups are separate",
                },
            )
        finally:
            if "app" in running:
                pid = i.start_node_service("app", "server/index.ts")
                i.wait_health(pid)
            if "worker" in running:
                i.start_node_service("worker", "server/worker.ts")
            if "interaction-worker" in running:
                i.start_node_service("interaction-worker", "server/interactions/templates.ts")
        json_write(root / "MANIFEST.json", manifest(root))
        plain = Path(temp) / "backup.tar"
        with tarfile.open(plain, "w") as tar:
            tar.add(root, arcname="backup")
        run(gpg(["--symmetric", "--cipher-algo", "AES256", "--output", str(dest), str(plain)], a.passphrase_file))
        check = Path(temp) / "check.tar"
        run(gpg(["--output", str(check), "--decrypt", str(dest)], a.passphrase_file), stdout=subprocess.DEVNULL)
        checked = Path(temp) / "checked"
        checked.mkdir()
        with tarfile.open(check) as tar:
            extract(tar, checked)
        verify(checked / "backup")
    dest.chmod(0o600)
    json_write(
        dest.with_suffix(dest.suffix + ".verification.json"),
        {"sha256": sha(dest), "bytes": dest.stat().st_size, "decryption_verified": True, "manifest_verified": True},
    )
    print(f"Encrypted, fully verified backup: {dest}")


def restore(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    if (
        i.pg_running()
        or i.service_pid("app")
        or any(i.pg_data.iterdir())
        or any(i.files_dir.iterdir())
    ):
        fail("Restore requires a NEW empty instance; existing data is never replaced")
    if not a.confirm_empty_target:
        fail("Review the new target and use --confirm-empty-target")
    with tempfile.TemporaryDirectory(prefix="groupdesk-restore-") as temp:
        temp = Path(temp)
        source = Path(a.source).resolve()
        if source.is_file():
            decrypted = temp / "input.tar"
            run(gpg(["--output", str(decrypted), "--decrypt", str(source)], a.passphrase_file), stdout=subprocess.DEVNULL)
            unpack = temp / "unpacked"
            unpack.mkdir()
            with tarfile.open(decrypted) as tar:
                extract(tar, unpack)
            roots = list(unpack.iterdir())
            if len(roots) != 1 or not roots[0].is_dir():
                fail("Expected one recovery root")
            source = roots[0]
        portable = (source / "metadata.json").exists()
        if portable:
            verify(source)
        elif (source / "FINAL-MANIFEST.json").exists():
            expected = json.loads((source / "FINAL-MANIFEST.json").read_text())
            for name, meta in expected.items():
                path = source / name
                if Path(name).is_absolute() or ".." in Path(name).parts or not path.is_file() or sha(path) != meta.get("sha256"):
                    fail("Legacy recovery manifest differs")
        else:
            fail("Unsupported recovery directory; manifest required")

        if portable:
            oldenv = env_read(source / "app.env")
        else:
            old = json.loads((source / "containers.json").read_text())["groupdesk-app-1"]["Config"]["Env"]
            oldenv = dict(v.split("=", 1) for v in old if "=" in v)
        for key in ["MODEL_ENCRYPTION_KEY", "ADMIN_USERNAME", "ADMIN_PASSWORD"]:
            if key in oldenv:
                i.appenv[key] = oldenv[key]
        i.appenv["BOT_API_TOKEN"] = secrets.token_hex(32)
        oldurl = urlsplit(oldenv["DATABASE_URL"])
        userinfo = oldurl.netloc.rsplit("@", 1)[0]
        i.appenv["DATABASE_URL"] = urlunsplit(
            (oldurl.scheme, f"{userinfo}@127.0.0.1:{i.pg_port}", oldurl.path, oldurl.query, oldurl.fragment)
        )
        env_write(i.config / "app.env", i.appenv)

        if portable:
            shutil.rmtree(i.files_dir)
            shutil.copytree(source / "files", i.files_dir, symlinks=False)
        else:
            with tarfile.open(source / "files-and-release.tar.gz") as tar:
                extract(tar, i.files_dir, "opt/persist/groupdesk/files/")

        i.pg_start()
        roles_sql = (source / "roles.sql").read_text()
        # Filter out CREATE ROLE for our own bootstrap superuser if present in source dump.
        boot = i.runtime_env["BOOTSTRAP_USER"]
        filtered = []
        for line in roles_sql.splitlines():
            if re.match(rf"^(CREATE|ALTER)\s+ROLE\s+\"?{re.escape(boot)}\"?\b", line):
                continue
            filtered.append(line)
        i.sql_stdin("postgres", ("\n".join(filtered) + "\n").encode())

        dbs = json.loads((source / "databases.json").read_text())
        expected_fp = json.loads((source / "database-fingerprints.json").read_text())
        matched = 0
        for record in dbs:
            db, owner = record["name"], record["owner"]
            if not re.fullmatch(r"groupdesk|gdb_[a-f0-9]{32}", db) or not re.fullmatch(r"[a-z_0-9]+", owner):
                fail("Unsafe database binding")
            run(
                [
                    i.pg_tool("createdb"),
                    "-h",
                    "127.0.0.1",
                    "-p",
                    str(i.pg_port),
                    "-U",
                    i.runtime_env["BOOTSTRAP_USER"],
                    "-O",
                    owner,
                    db,
                ],
                env=i.pg_env(),
                stdout=subprocess.DEVNULL,
            )
            with (source / "databases" / f"{db}.dump").open("rb") as f:
                run(
                    [
                        i.pg_tool("pg_restore"),
                        "--exit-on-error",
                        "-h",
                        "127.0.0.1",
                        "-p",
                        str(i.pg_port),
                        "-U",
                        i.runtime_env["BOOTSTRAP_USER"],
                        "-d",
                        db,
                    ],
                    env=i.pg_env(),
                    stdin=f,
                    stdout=subprocess.DEVNULL,
                )
            actual = i.fingerprints(db)
            if actual != expected_fp[db]:
                fail(f"Restored table content differs: {db}")
            matched += len(actual)

        i.runtime("--import", "tsx", "distribution/reconcile.ts")
        app_pid = i.start_node_service("app", "server/index.ts")
        i.wait_health(app_pid)
        json_write(
            i.root / "restore-validation.json",
            {
                "status": "passed",
                "mode": "macos-native",
                "restored_databases": len(dbs),
                "matching_tables": matched,
                "old_data_checked_before_migrations": True,
                "robots_paused": True,
                "workers_started": False,
                "runtime_connections_invalidated": True,
                "node_version": i.node_version,
                "postgres_version": i.pg_info["version"],
            },
        )
    print(f"Restore passed. Robots paused, old connections invalidated, workers NOT started. Review: {i.root / 'restore-validation.json'}")


def open_browser(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    run(["open", i.appenv["PUBLIC_ORIGIN"]])


def launchd_plist_path(project):
    return Path.home() / "Library/LaunchAgents" / f"com.groupdesk.{project}.plist"


def launchd_install(a):
    import plistlib

    i = Instance(a.target, a.node_bin, a.postgres_bin)
    plist_path = launchd_plist_path(i.meta["project"])
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    args = [sys.executable, str(Path(__file__).resolve()), "up", "--target", str(i.root)]
    if a.workers:
        if i.meta["isolated"]:
            fail("Workers cannot be enabled in an isolated instance")
        args.append("--workers")
    plist = {
        "Label": f"com.groupdesk.{i.meta['project']}",
        "ProgramArguments": args,
        "RunAtLoad": True,
        "StandardOutPath": str(i.log_dir / "launchd.out.log"),
        "StandardErrorPath": str(i.log_dir / "launchd.err.log"),
    }
    with plist_path.open("wb") as f:
        plistlib.dump(plist, f)
    plist_path.chmod(0o600)
    print(f"LaunchAgent installed: {plist_path}")


def launchd_uninstall(a):
    i = Instance(a.target, a.node_bin, a.postgres_bin)
    plist_path = launchd_plist_path(i.meta["project"])
    if plist_path.exists():
        subprocess.run(["launchctl", "unload", str(plist_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        plist_path.unlink()
        print(f"LaunchAgent removed: {plist_path}")
    else:
        print("LaunchAgent not installed")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--node-bin", help="Override path to Node.js >=22.13 binary")
    p.add_argument("--postgres-bin", help="Override path to PostgreSQL 16 bin directory")
    sub = p.add_subparsers(dest="action", required=True)

    init = sub.add_parser("init", help="Initialize a new isolated GroupDesk instance")
    init.add_argument("--target", required=True)
    init.add_argument("--project", default="gd-macos")
    init.add_argument("--port", type=int, default=3110)
    init.add_argument("--pg-port", type=int, default=0)
    init.add_argument("--origin")
    init.add_argument("--admin", default="admin")
    init.add_argument("--admin-password-file")
    init.add_argument("--isolated", action="store_true")

    for action in ["up", "down", "status", "logs", "backup", "restore", "open", "launchd-install", "launchd-uninstall"]:
        s = sub.add_parser(action)
        s.add_argument("--target", required=True)
        if action in {"up", "launchd-install"}:
            s.add_argument("--workers", action="store_true")
        if action == "status":
            s.add_argument("--json", action="store_true")
        if action == "logs":
            s.add_argument("--service", choices=["all", "app", "postgres", "worker", "interaction-worker"], default="all")
            s.add_argument("--lines", type=int, default=60)
        if action == "backup":
            s.add_argument("--output", required=True)
            s.add_argument("--passphrase-file")
        if action == "restore":
            s.add_argument("--source", required=True)
            s.add_argument("--passphrase-file")
            s.add_argument("--confirm-empty-target", action="store_true")

    a = p.parse_args()
    handlers = {
        "init": initialize,
        "up": up,
        "down": down,
        "status": status,
        "logs": logs,
        "backup": backup,
        "restore": restore,
        "open": open_browser,
        "launchd-install": launchd_install,
        "launchd-uninstall": launchd_uninstall,
    }
    handlers[a.action](a)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(
            "GroupDesk macOS operation stopped:",
            type(error).__name__,
            str(error) if isinstance(error, RuntimeError) else "Check prerequisites and private instance logs. No existing instance is replaced.",
            file=sys.stderr,
        )
        sys.exit(1)
