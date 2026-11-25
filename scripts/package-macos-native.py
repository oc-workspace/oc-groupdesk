#!/usr/bin/env python3
"""Build a self-contained, Docker-free macOS native standalone package (.app, .dmg, .tar.gz).

Starts from a clean public source package (scripts/package-standalone.py allowlist),
prebuilds frontend + production node_modules, bundles Node >=22.13 and relocatable
PostgreSQL 16 (with verified Mach-O dylib relocation and ad-hoc codesign), and
wraps everything in GroupDesk.app + .dmg + .tar.gz with SHA256SUMS.
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zlib
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PG_TOOLS = [
    "postgres",
    "initdb",
    "pg_ctl",
    "psql",
    "pg_isready",
    "createdb",
    "pg_dump",
    "pg_dumpall",
    "pg_restore",
    "pg_config",
]


def fail(msg):
    raise RuntimeError(msg)


def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, **kw)


def capture(args, **kw):
    return subprocess.check_output([str(a) for a in args], text=True, **kw).strip()


def sha256_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_node_version(text):
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", text.strip())
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def detect_node(explicit=None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    which_node = shutil.which("node")
    if which_node:
        candidates.append(Path(which_node))
    nvm_dir = Path.home() / ".nvm/versions/node"
    if nvm_dir.is_dir():
        for entry in sorted(nvm_dir.iterdir(), reverse=True):
            candidates.append(entry / "bin/node")
    for p in [Path("/opt/homebrew/opt/node@22/bin/node"), Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node")]:
        candidates.append(p)
    for cand in candidates:
        if cand.is_file() and os.access(cand, os.X_OK):
            try:
                ver = capture([cand, "-v"])
                if parse_node_version(ver) >= (22, 13, 0):
                    real = cand.resolve()
                    npm = real.parent / "npm"
                    if npm.is_file():
                        return real, npm, ver
            except (subprocess.CalledProcessError, OSError):
                continue
    fail("Could not find Node.js >= 22.13 with npm on this Mac.")


def detect_postgres(explicit=None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    candidates.extend([
        Path("/opt/homebrew/opt/postgresql@16"),
        Path("/usr/local/opt/postgresql@16"),
    ])
    which_pg = shutil.which("postgres")
    if which_pg:
        candidates.append(Path(which_pg).resolve().parent.parent)
    for prefix in candidates:
        bin_dir = prefix / "bin"
        if bin_dir.is_dir() and all((bin_dir / t).is_file() for t in PG_TOOLS):
            ver = capture([bin_dir / "postgres", "--version"])
            return prefix.resolve(), ver
    fail("Could not find PostgreSQL 16 installation (e.g. /opt/homebrew/opt/postgresql@16).")


def is_macho(path):
    if not path.is_file() or path.is_symlink():
        return False
    try:
        with path.open("rb") as f:
            magic = f.read(4)
        return magic in {
            b"\xcf\xfa\xed\xfe",  # MH_MAGIC_64
            b"\xfe\xed\xfa\xcf",  # MH_CIGAM_64
            b"\xca\xfe\xba\xbe",  # FAT_MAGIC
            b"\xbe\xba\xfe\xca",  # FAT_CIGAM
        }
    except OSError:
        return False


def otool_deps(path):
    out = capture(["otool", "-L", str(path)])
    deps = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        dep = line.split(" (", 1)[0].strip()
        if dep:
            deps.append(dep)
    return deps


def otool_rpaths(path):
    out = capture(["otool", "-l", str(path)])
    rpaths = []
    lines = out.splitlines()
    for idx, line in enumerate(lines):
        if "cmd LC_RPATH" in line:
            for sub in lines[idx + 1 : idx + 6]:
                m = re.search(r"path\s+(.+?)\s+\(offset", sub)
                if m:
                    rpaths.append(m.group(1).strip())
                    break
    return rpaths


def is_system_dep(dep):
    return dep.startswith("/usr/lib/") or dep.startswith("/System/Library/")


def resolve_dep_source(dep, orig_file, pg_prefix):
    orig_dir = orig_file.parent
    if dep.startswith("/"):
        p = Path(dep)
        if p.exists():
            return p.resolve()
    elif dep.startswith("@loader_path/"):
        rel = dep[len("@loader_path/"):]
        p = (orig_dir / rel).resolve()
        if p.exists():
            return p
    elif dep.startswith("@executable_path/"):
        rel = dep[len("@executable_path/"):]
        p = (pg_prefix / "bin" / rel).resolve()
        if p.exists():
            return p
    elif dep.startswith("@rpath/"):
        rel = dep[len("@rpath/"):]
        search_dirs = []
        for rp in otool_rpaths(orig_file):
            if rp.startswith("@loader_path"):
                search_dirs.append((orig_dir / rp[len("@loader_path"):].lstrip("/")).resolve())
            elif rp.startswith("@executable_path"):
                search_dirs.append((pg_prefix / "bin" / rp[len("@executable_path"):].lstrip("/")).resolve())
            else:
                search_dirs.append(Path(rp))
        search_dirs.extend([orig_dir, pg_prefix / "lib"])
        for d in search_dirs:
            cand = (d / rel).resolve()
            if cand.exists():
                return cand
    fail(f"Could not resolve Mach-O dependency {dep} referenced by {orig_file}")


def bundle_relocatable_postgres(pg_prefix, dest_pg):
    """Copy PostgreSQL 16 binaries, extensions, share data, and transitive Homebrew dylibs,
    rewriting Mach-O load commands to @loader_path and ad-hoc signing every binary."""
    bin_dir = dest_pg / "bin"
    lib_dir = dest_pg / "lib"
    pkglib_dir = lib_dir / "postgresql"
    share_dir = dest_pg / "share/postgresql@16"
    bin_dir.mkdir(parents=True, exist_ok=True)
    pkglib_dir.mkdir(parents=True, exist_ok=True)

    # Track (bundled_path -> original_source_path) for dependency resolution.
    origin_map = {}
    queue = deque()

    for tool in PG_TOOLS:
        src = (pg_prefix / "bin" / tool).resolve()
        dst = bin_dir / tool
        shutil.copy2(src, dst)
        dst.chmod(0o755)
        origin_map[dst] = src
        queue.append(dst)

    # Copy libpq and core PostgreSQL dylibs (skip static .a archives).
    for item in (pg_prefix / "lib").iterdir():
        if item.is_file() and item.suffix == ".dylib" and not item.is_symlink():
            dst = lib_dir / item.name
            shutil.copy2(item.resolve(), dst)
            dst.chmod(0o755)
            origin_map[dst] = item.resolve()
            queue.append(dst)

    # Copy PostgreSQL server loadable modules (.so / .dylib).
    src_pkglib = pg_prefix / "lib/postgresql"
    if src_pkglib.is_dir():
        for item in src_pkglib.iterdir():
            if item.is_file() and item.suffix in {".so", ".dylib"} and not item.is_symlink():
                dst = pkglib_dir / item.name
                shutil.copy2(item.resolve(), dst)
                dst.chmod(0o755)
                origin_map[dst] = item.resolve()
                queue.append(dst)

    # Copy share data required by initdb and runtime (timezone, encodings, tsearch, postgres.bki).
    src_share = pg_prefix / "share/postgresql@16"
    if not src_share.is_dir():
        src_share = pg_prefix / "share/postgresql"
    if not src_share.is_dir():
        fail(f"PostgreSQL share directory not found under {pg_prefix}/share")
    shutil.copytree(
        src_share,
        share_dir,
        symlinks=False,
        ignore=shutil.ignore_patterns("man", "doc"),
    )

    processed = set()
    bundled_dylibs = {}  # basename -> bundled Path

    while queue:
        target = queue.popleft()
        if target in processed or not is_macho(target):
            continue
        processed.add(target)
        orig_src = origin_map[target]
        in_lib_root = target.parent == lib_dir

        if target.suffix == ".dylib":
            run(["install_name_tool", "-id", f"@loader_path/{target.name}", str(target)])

        for dep in otool_deps(target):
            if is_system_dep(dep):
                continue
            dep_name = Path(dep).name
            # Skip self-install-name entry in dylibs.
            if target.suffix == ".dylib" and dep_name == target.name:
                continue
            if dep_name not in bundled_dylibs:
                resolved = resolve_dep_source(dep, orig_src, pg_prefix)
                dst_lib = lib_dir / dep_name
                if not dst_lib.exists():
                    shutil.copy2(resolved, dst_lib)
                    dst_lib.chmod(0o755)
                    origin_map[dst_lib] = resolved
                    queue.append(dst_lib)
                bundled_dylibs[dep_name] = dst_lib
            new_ref = f"@loader_path/{dep_name}" if in_lib_root else f"@loader_path/../lib/{dep_name}"
            if dep != new_ref:
                run(["install_name_tool", "-change", dep, new_ref, str(target)])

    # Verification pass: ensure ZERO non-system external dylib references remain.
    macho_files = [p for p in sorted(dest_pg.rglob("*")) if is_macho(p)]
    external_refs = []
    for mf in macho_files:
        for dep in otool_deps(mf):
            if is_system_dep(dep) or dep.startswith("@loader_path/"):
                continue
            external_refs.append((str(mf.relative_to(dest_pg)), dep))
    if external_refs:
        fail(f"Unrelocated Mach-O dependencies found: {external_refs[:5]}")

    # Ad-hoc sign all Mach-O files (required on Apple Silicon after install_name_tool).
    order = (
        [p for p in macho_files if p.parent == lib_dir]
        + [p for p in macho_files if p.parent == pkglib_dir]
        + [p for p in macho_files if p.parent == bin_dir]
    )
    for mf in order:
        run(["codesign", "--force", "--sign", "-", str(mf)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return len(macho_files)


def render_icon_png(size):
    raw = bytearray()
    cx, cy = size / 2.0, size / 2.0
    scale = size / 512.0
    pad = 36.0 * scale
    corner = 88.0 * scale
    half_box = size / 2.0 - pad - corner
    for y in range(size):
        raw.append(0)
        for x in range(size):
            rx = max(0.0, abs(x - cx) - half_box)
            ry = max(0.0, abs(y - cy) - half_box)
            if (rx * rx + ry * ry) ** 0.5 > corner:
                raw.extend((0, 0, 0, 0))
                continue
            t = (x + y) / (2.0 * size)
            r = int(38 + (24 * t))
            g = int(78 + (58 * t))
            b = int(214 - (20 * t))
            dx, dy = (x - cx) / scale, (y - cy) / scale
            rad = (dx * dx + dy * dy) ** 0.5
            in_ring = 92.0 <= rad <= 140.0 and not (dx > 18.0 and -65.0 < dy < -8.0)
            in_bar = (12.0 <= dx <= 140.0) and (-12.0 <= dy <= 34.0)
            if in_ring or in_bar:
                r, g, b = 255, 255, 255
            raw.extend((r, g, b, 255))

    def png_chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + png_chunk(b"IEND", b"")


def generate_app_icon_icns(dest_icns):
    """Generate a valid macOS .icns app icon with PNG-encoded ic07/ic08/ic09 chunks."""
    chunks = bytearray()
    for tag, px in [(b"ic07", 128), (b"ic08", 256), (b"ic09", 512)]:
        png_bytes = render_icon_png(px)
        chunks.extend(tag + struct.pack(">I", 8 + len(png_bytes)) + png_bytes)
    dest_icns.write_bytes(b"icns" + struct.pack(">I", 8 + len(chunks)) + bytes(chunks))


LAUNCHER_SCRIPT = r'''#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="$APP_DIR/Resources/bundle"
MANAGE="$BUNDLE_DIR/distribution/manage-macos.py"
TARGET="$HOME/Library/Application Support/GroupDesk/default"

find_python3() {
  for cand in \
    "$(command -v python3 2>/dev/null || true)" \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
    /usr/bin/python3; do
    if [[ -n "$cand" && -x "$cand" ]]; then
      if "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
        echo "$cand"
        return 0
      fi
    fi
  done
  return 1
}

run_in_terminal() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run
APPLESCRIPT
}

show_alert() {
  osascript - "$1" "$2" <<'APPLESCRIPT'
on run argv
  display alert (item 1 of argv) message (item 2 of argv) as critical
end run
APPLESCRIPT
}

PY="$(find_python3 || true)"
if [[ -z "$PY" ]]; then
  show_alert "需要 Python 3.10+" "未在本机找到 Python 3.10 或更高版本。请先安装 Python 3（例如 brew install python）后再启动 GroupDesk。"
  exit 1
fi

if [[ ! -f "$TARGET/instance.json" ]]; then
  SETUP_CMD="clear; echo '=== GroupDesk macOS 原生实例首次初始化 ==='; echo '实例目录: $TARGET'; echo ''; '$PY' '$MANAGE' init --target '$TARGET' --project gd-macos --port 3110 && '$PY' '$MANAGE' up --target '$TARGET' && '$PY' '$MANAGE' open --target '$TARGET'; echo ''; echo '提示：可关闭此窗口，服务将在后台持续运行。再次双击 GroupDesk.app 可打开网页或停止服务。'"
  run_in_terminal "$SETUP_CMD"
  exit 0
fi

STATUS_JSON="$("$PY" "$MANAGE" status --target "$TARGET" --json 2>/dev/null || true)"
IS_HEALTHY="$("$PY" -c 'import json,sys; d=json.loads(sys.argv[1]) if sys.argv[1] else {}; print("1" if d.get("health") else "0")' "$STATUS_JSON" 2>/dev/null || echo "0")"
ORIGIN="$("$PY" -c 'import json,sys; d=json.loads(sys.argv[1]) if sys.argv[1] else {}; print(d.get("origin","http://localhost:3110"))' "$STATUS_JSON" 2>/dev/null || echo "http://localhost:3110")"

if [[ "$IS_HEALTHY" == "1" ]]; then
  CHOICE="$(osascript - "$ORIGIN" "$TARGET" <<'APPLESCRIPT' 2>/dev/null || true
on run argv
  set msg to "GroupDesk 正在本机运行：" & return & (item 1 of argv) & return & return & "实例目录：" & (item 2 of argv)
  return button returned of (display dialog msg with title "GroupDesk" buttons {"停止服务", "查看日志", "打开网页"} default button "打开网页")
end run
APPLESCRIPT
)"
  case "$CHOICE" in
    "打开网页")
      open "$ORIGIN"
      ;;
    "停止服务")
      "$PY" "$MANAGE" down --target "$TARGET"
      osascript -e 'display notification "GroupDesk 服务及私有 PostgreSQL 已停止" with title "GroupDesk"'
      ;;
    "查看日志")
      LOG_CMD="'$PY' '$MANAGE' logs --target '$TARGET' --lines 100"
      run_in_terminal "$LOG_CMD"
      ;;
  esac
  exit 0
fi

if ! ERR="$("$PY" "$MANAGE" up --target "$TARGET" 2>&1)"; then
  show_alert "GroupDesk 启动失败" "$ERR"
  exit 1
fi
open "$ORIGIN"
'''


def verify_source_bundle(root):
    sums = root / "SHA256SUMS"
    if not sums.is_file():
        fail("Source package missing SHA256SUMS")
    for line in sums.read_text().splitlines():
        if not line.strip():
            continue
        expected, rel = line.split("  ", 1)
        target = root / rel
        if not target.is_file() or sha256_file(target) != expected:
            fail(f"Source bundle checksum mismatch: {rel}")


def main():
    if sys.platform != "darwin":
        fail("scripts/package-macos-native.py must be run on macOS")

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--version", required=True, help="Package version tag, e.g. 0.1.0-standalone-macos-rc1")
    p.add_argument("--name-prefix", default="groupdesk-standalone", help="Output filename prefix")
    p.add_argument("--output-dir", required=True, help="Directory where .dmg, .tar.gz, and receipts are written")
    p.add_argument("--source-tar", help="Existing clean source .tar.gz from scripts/package-standalone.py")
    p.add_argument("--node-bin", help="Path to Node.js >=22.13 binary")
    p.add_argument("--postgres-prefix", help="Path to PostgreSQL 16 prefix (e.g. /opt/homebrew/opt/postgresql@16)")
    p.add_argument("--stage-dir", help="Optional persistent directory to export dmg-stage (GroupDesk.app)")
    p.add_argument("--skip-dmg", action="store_true", help="Skip hdiutil .dmg creation (e.g. to sign/notarize app first)")
    a = p.parse_args()

    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", a.version):
        fail("Invalid version string")

    arch = platform.machine()
    node_bin, npm_bin, node_ver = detect_node(a.node_bin)
    pg_prefix, pg_ver = detect_postgres(a.postgres_prefix)

    out_dir = Path(a.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle_name = f"{a.name_prefix}-macos-{arch}"
    tar_dest = out_dir / f"{bundle_name}.tar.gz"
    dmg_dest = out_dir / f"{bundle_name}.dmg"
    if tar_dest.exists() or dmg_dest.exists():
        fail("Output package files already exist; choose a new output directory or name prefix")

    with tempfile.TemporaryDirectory(prefix="gd-macos-build-") as tmp:
        tmp = Path(tmp)
        if a.source_tar:
            source_tar = Path(a.source_tar).resolve()
        else:
            source_tar = tmp / f"source-{a.version}.tar.gz"
            run([sys.executable, str(ROOT / "scripts/package-standalone.py"), "--output", str(source_tar), "--version", a.version])
        source_sha = sha256_file(source_tar)

        unpack = tmp / "unpack"
        unpack.mkdir()
        with tarfile.open(source_tar, "r:gz") as tar:
            for m in tar:
                rel = Path(m.name)
                if rel.is_absolute() or ".." in rel.parts or m.issym() or m.islnk():
                    fail(f"Unsafe source tarball member: {m.name}")
            tar.extractall(unpack)
        roots = [d for d in unpack.iterdir() if d.is_dir()]
        if len(roots) != 1:
            fail("Expected a single root directory in source tarball")
        bundle = roots[0]
        verify_source_bundle(bundle)

        # Build frontend and prune to production dependencies using Node >=22.13.
        build_env = os.environ.copy()
        build_env["PATH"] = f"{node_bin.parent}:{build_env.get('PATH', '/usr/bin:/bin')}"
        run([npm_bin, "ci", "--no-fund"], cwd=str(bundle), env=build_env)
        run([npm_bin, "run", "build"], cwd=str(bundle), env=build_env)
        shutil.rmtree(bundle / "node_modules")
        run([npm_bin, "ci", "--omit=dev", "--no-fund"], cwd=str(bundle), env=build_env)
        if not (bundle / "dist/index.html").is_file():
            fail("Frontend build output dist/index.html missing")

        # Bundle standalone Node binary and verify zero external non-system dylib dependencies.
        dest_node = bundle / "runtime/node/bin/node"
        dest_node.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(node_bin, dest_node)
        dest_node.chmod(0o755)
        node_ext = [d for d in otool_deps(dest_node) if not is_system_dep(d)]
        if node_ext:
            fail(f"Node binary has non-system dylib dependencies: {node_ext}")
        run(["codesign", "--force", "--sign", "-", str(dest_node)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # Bundle relocatable PostgreSQL 16.
        pg_macho_count = bundle_relocatable_postgres(pg_prefix, bundle / "runtime/postgres")

        # Write runtime manifest & top-level SHA256SUMS.
        runtime_manifest = {
            "format": 1,
            "version": a.version,
            "platform": f"darwin/{arch}",
            "macos_build_host": platform.mac_ver()[0],
            "docker_required": False,
            "private_data_included": False,
            "private_images_used": False,
            "source_package_sha256": source_sha,
            "node_version": node_ver,
            "postgres_version": pg_ver,
            "postgres_relocated_macho_files": pg_macho_count,
            "relocation_verified": True,
            "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        (bundle / "RUNTIME-MANIFEST.json").write_text(json.dumps(runtime_manifest, ensure_ascii=False, indent=2) + "\n")

        # 1. Create CLI .tar.gz bundle.
        with tarfile.open(tar_dest, "w:gz") as tar:
            tar.add(bundle, arcname=bundle_name)

        # 2. Wrap into GroupDesk.app and optionally create .dmg.
        if a.stage_dir:
            dmg_stage = Path(a.stage_dir).resolve()
            if dmg_stage.exists():
                fail("Stage directory already exists")
            dmg_stage.mkdir(parents=True)
        else:
            dmg_stage = tmp / "dmg-stage"
            dmg_stage.mkdir()
        app_root = dmg_stage / "GroupDesk.app"
        contents = app_root / "Contents"
        macos_dir = contents / "MacOS"
        res_dir = contents / "Resources"
        macos_dir.mkdir(parents=True)
        res_dir.mkdir(parents=True)

        info_plist = {
            "CFBundleDevelopmentRegion": "zh_CN",
            "CFBundleDisplayName": "GroupDesk",
            "CFBundleExecutable": "GroupDesk",
            "CFBundleIconFile": "AppIcon",
            "CFBundleIdentifier": "com.groupdesk.standalone",
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleName": "GroupDesk",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": a.version,
            "LSMinimumSystemVersion": "14.0",
            "NSHighResolutionCapable": True,
        }
        with (contents / "Info.plist").open("wb") as f:
            plistlib.dump(info_plist, f)

        generate_app_icon_icns(res_dir / "AppIcon.icns")
        launcher = macos_dir / "GroupDesk"
        launcher.write_text(LAUNCHER_SCRIPT)
        launcher.chmod(0o755)
        shutil.copytree(bundle, res_dir / "bundle", symlinks=True)

        # Ad-hoc sign the outer .app bundle (inner Mach-O binaries are already signed individually).
        run(["codesign", "--force", "--sign", "-", str(app_root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        os.symlink("/Applications", dmg_stage / "Applications")
        readme_src = bundle / "distribution/README-macos.md"
        if readme_src.is_file():
            shutil.copy2(readme_src, dmg_stage / "安装与使用说明.md")

        if not a.skip_dmg:
            run([
                "hdiutil",
                "create",
                "-volname",
                "GroupDesk",
                "-srcfolder",
                str(dmg_stage),
                "-ov",
                "-format",
                "UDZO",
                str(dmg_dest),
            ], stdout=subprocess.DEVNULL)

    tar_sha = sha256_file(tar_dest)
    artifacts = {
        "tar_gz": {"file": tar_dest.name, "sha256": tar_sha, "bytes": tar_dest.stat().st_size},
    }
    sums_lines = []
    if not a.skip_dmg and dmg_dest.is_file():
        dmg_sha = sha256_file(dmg_dest)
        artifacts["dmg"] = {"file": dmg_dest.name, "sha256": dmg_sha, "bytes": dmg_dest.stat().st_size}
        sums_lines.append(f"{dmg_sha}  {dmg_dest.name}")
    sums_lines.append(f"{tar_sha}  {tar_dest.name}")
    (out_dir / "SHA256SUMS").write_text("\n".join(sums_lines) + "\n")
    result = {
        "version": a.version,
        "platform": f"darwin/{arch}",
        "docker_required": False,
        "private_data_included": False,
        "source_package_sha256": source_sha,
        "node_version": node_ver,
        "postgres_version": pg_ver,
        "relocation_verified": True,
        "artifacts": artifacts,
    }
    (out_dir / "macos-package-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
