#!/usr/bin/env python3
"""Build an isolated, pinned local Whisper runtime. No system packages or cloud audio."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time

COMMIT = "48f628a84833905ee4a0658ee6d4a5c915ce1997"  # whisper.cpp v1.8.7
MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1"
MODEL_HASH = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
MODEL_SIZE = 147951465


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, timeout=900, **kwargs)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target):
    partial = target.with_suffix(target.suffix + ".partial")
    try:
        run(["/usr/bin/curl", "--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--retry", "2", "--connect-timeout", "20", "--max-time", "600", "--output", partial, url])
        partial.replace(target)
        target.chmod(0o600)
    finally:
        partial.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".data/voice").expanduser().absolute()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise RuntimeError("Runtime directory cannot be a symlink")
    lock = root / ".setup.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, str(os.getpid()).encode())
        tools = root / "build-tools"
        if not (tools / "bin/cmake").exists():
            print("Installing CMake into the JARVIS-only virtual environment", flush=True)
            run([sys.executable, "-m", "venv", tools])
            run([tools / "bin/python", "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", "cmake==3.31.6"])
        archive = root / "whisper-source.tar.gz"
        source = root / ("whisper.cpp-" + COMMIT)
        if not source.exists():
            print("Downloading pinned official whisper.cpp source", flush=True)
            download("https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/" + COMMIT, archive)
            with tarfile.open(archive) as package:
                for member in package.getmembers():
                    parts = Path(member.name).parts
                    if not parts or parts[0] != source.name or ".." in parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                        raise RuntimeError("Unsafe source archive member")
                package.extractall(root)
        build = source / "build-jarvis"
        cmake = tools / "bin/cmake"
        print("Building CPU-only whisper-cli using two native build jobs", flush=True)
        run([cmake, "-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_CURL=OFF", "-DGGML_METAL=OFF", "-DGGML_OPENMP=OFF"])
        run([cmake, "--build", build, "--config", "Release", "--target", "whisper-cli", "--parallel", "2"])
        (root / "bin").mkdir(exist_ok=True, mode=0o700)
        executable = root / "bin/whisper-cli"
        shutil.copy2(build / "bin/whisper-cli", executable)
        executable.chmod(0o700)
        model = root / "ggml-base.bin"
        if not model.exists() or model.stat().st_size != MODEL_SIZE or sha256(model) != MODEL_HASH:
            print("Downloading the official linked multilingual base model (148 MB)", flush=True)
            download("https://huggingface.co/ggerganov/whisper.cpp/resolve/" + MODEL_REVISION + "/ggml-base.bin", model)
        if model.stat().st_size != MODEL_SIZE or sha256(model) != MODEL_HASH:
            model.unlink(missing_ok=True)
            raise RuntimeError("Model integrity verification failed")
        run([executable, "--help"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        metadata = {"version": 1, "engine": "whisper.cpp", "release": "v1.8.7", "sourceCommit": COMMIT, "model": "base-multilingual", "modelRevision": MODEL_REVISION, "modelSha256": MODEL_HASH, "binarySha256": sha256(executable), "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cloudAudio": False}
        temporary = root / "runtime.json.partial"
        temporary.write_text(json.dumps(metadata, indent=2) + "\n")
        temporary.replace(root / "runtime.json")
        print(json.dumps({"status": "installed", "runtimeDir": str(root), **metadata}), flush=True)
    finally:
        os.close(descriptor)
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Voice setup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
