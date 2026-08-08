from __future__ import annotations

import argparse
import asyncio
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
    return result


async def _watch_parent(server: uvicorn.Server, parent_pid: int | None) -> None:
    if not parent_pid:
        return
    while not server.should_exit:
        try:
            os.kill(parent_pid, 0)
        except OSError:
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
    config = uvicorn.Config(app, host=settings.host, port=port, log_level=settings.log_level,
                            access_log=False, server_header=False, date_header=False)
    server = uvicorn.Server(config)
    print("AIVS_READY " + json.dumps({"protocol_version": PROTOCOL_VERSION, "port": port,
                                      "pid": os.getpid(), "build_version": __version__}, separators=(",", ":")),
          flush=True)
    parent_task = asyncio.create_task(_watch_parent(server, settings.parent_pid))
    shutdown_task = asyncio.create_task(_watch_shutdown(server, app.state.core.shutdown_event))
    try:
        await server.serve(sockets=[sock])
    finally:
        parent_task.cancel(); shutdown_task.cancel()
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
