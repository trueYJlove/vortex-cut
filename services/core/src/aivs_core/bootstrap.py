from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
import socket
import sys

import uvicorn

from . import PROTOCOL_VERSION, __version__
from .app import create_app
from .config import Settings, admin_token_from_environment


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="AIVideo Stage 0 Core")
    result.add_argument("--host", default="127.0.0.1")
    result.add_argument("--port", type=int, default=0)
    result.add_argument("--parent-pid", type=int)
    result.add_argument("--data-dir", default=".aivideo")
    result.add_argument("--ffmpeg", default="ffmpeg")
    result.add_argument("--ffprobe", default="ffprobe")
    result.add_argument("--runtime-dir")
    result.add_argument("--log-level", default="info")
    result.add_argument("--ready-file")
    result.add_argument("--manifest-dir")
    result.add_argument(
        "--enable-image-provider-network",
        action="store_true",
        help="Explicitly enable the fixed Stage 4D image Provider adapter",
    )
    return result


def _process_exists(pid: int) -> bool:
    """Return ``True`` if a process with ``pid`` is still running.

    On Windows, ``os.kill(pid, 0)`` must not be used as a null-signal check:
    CPython's implementation treats signal ``0`` as ``CTRL_C_EVENT`` (both are
    0) and calls ``GenerateConsoleCtrlEvent``, delivering a CTRL+C to every
    process attached to the caller's console. When the sidecar shares a console
    with its Electron/Node parent this terminates the parent, which surfaced as
    the desktop app flashing and closing immediately after startup. Query the
    process handle instead.
    """
    if sys.platform == "win32":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


async def _watch_parent(server: uvicorn.Server, parent_pid: int | None) -> None:
    if not parent_pid:
        return
    while not server.should_exit:
        if not _process_exists(parent_pid):
            server.should_exit = True
            return
        await asyncio.sleep(2)


async def _watch_shutdown(server: uvicorn.Server, event: asyncio.Event) -> None:
    await event.wait()
    server.should_exit = True


async def run(settings: Settings) -> None:
    settings.prepare()
    app = create_app(settings)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((settings.host, settings.port))
    sock.listen(128)
    sock.setblocking(False)
    port = int(sock.getsockname()[1])
    if settings.ready_file:
        os.environ["AIVS_READY_FILE"] = str(settings.ready_file)
    os.environ["AIVS_BOUND_PORT"] = str(port)
    config = uvicorn.Config(
        app,
        host=settings.host,
        port=port,
        log_level=settings.log_level,
        access_log=False,
        server_header=False,
        date_header=False,
    )
    server = uvicorn.Server(config)
    ready = {
        "protocol_version": PROTOCOL_VERSION,
        "port": port,
        "pid": os.getpid(),
        "build_version": __version__,
    }
    print("AIVS_READY " + json.dumps(ready, separators=(",", ":")), flush=True)
    parent_task = asyncio.create_task(_watch_parent(server, settings.parent_pid))
    shutdown_task = asyncio.create_task(_watch_shutdown(server, app.state.core.shutdown_event))
    try:
        await server.serve(sockets=[sock])
    finally:
        parent_task.cancel()
        shutdown_task.cancel()
        await asyncio.gather(parent_task, shutdown_task, return_exceptions=True)


def main() -> None:
    args = parser().parse_args()
    try:
        admin_token_from_environment()
        settings = Settings.from_args(args)
        asyncio.run(run(settings))
    except KeyboardInterrupt:
        return
    except Exception as exc:
        print(f"Core startup failed: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
