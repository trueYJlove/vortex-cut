import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from aivs_core import bootstrap
from aivs_core.config import Settings


def test_parser_defaults_and_arguments():
    args = bootstrap.parser().parse_args(["--port", "1234", "--data-dir", "data"])
    assert args.host == "127.0.0.1"
    assert args.port == 1234
    assert args.data_dir == "data"


@pytest.mark.asyncio
async def test_watch_helpers():
    class Server:
        should_exit = False

    server = Server()
    await bootstrap._watch_parent(server, None)
    event = asyncio.Event()
    task = asyncio.create_task(bootstrap._watch_shutdown(server, event))
    event.set()
    await task
    assert not server.should_exit or server.should_exit


def test_process_exists_non_windows_and_windows(monkeypatch):
    monkeypatch.setattr(bootstrap.sys, "platform", "linux")

    def fake_kill(pid, _signal):
        if pid != 1:
            raise OSError

    monkeypatch.setattr(bootstrap.os, "kill", fake_kill)
    assert bootstrap._process_exists(1)
    assert not bootstrap._process_exists(2)

    class Kernel:
        def OpenProcess(self, *_args):
            return 7

        def GetExitCodeProcess(self, _handle, value):
            value._obj.value = 259
            return 1

        def CloseHandle(self, _handle):
            return None

    monkeypatch.setattr(bootstrap.sys, "platform", "win32")
    monkeypatch.setattr(
        bootstrap.ctypes, "windll", SimpleNamespace(kernel32=Kernel()), raising=False
    )
    assert bootstrap._process_exists(123)

    class NoHandle(Kernel):
        def OpenProcess(self, *_args):
            return 0

    monkeypatch.setattr(
        bootstrap.ctypes, "windll", SimpleNamespace(kernel32=NoHandle()), raising=False
    )
    assert not bootstrap._process_exists(123)


@pytest.mark.asyncio
async def test_watch_parent_sets_exit_when_parent_is_gone(monkeypatch):
    class Server:
        should_exit = False

    monkeypatch.setattr(bootstrap, "_process_exists", lambda _pid: False)
    server = Server()
    await bootstrap._watch_parent(server, 123)
    assert server.should_exit


@pytest.mark.asyncio
async def test_run_binds_socket_and_cleans_watcher_tasks(monkeypatch, tmp_path: Path):
    class Socket:
        def setsockopt(self, *_args):
            return None

        def bind(self, address):
            self.address = address

        def listen(self, _backlog):
            return None

        def setblocking(self, value):
            self.blocking = value

        def getsockname(self):
            return ("127.0.0.1", 43210)

    class FakeServer:
        should_exit = False

        def __init__(self, _config):
            self.config = _config

        async def serve(self, sockets):
            self.socket = sockets[0]
            self.should_exit = True

    settings = Settings(
        data_dir=tmp_path / "data",
        runtime_dir=tmp_path / "runtime",
        ready_file=tmp_path / "ready.json",
    )
    app = SimpleNamespace(
        state=SimpleNamespace(core=SimpleNamespace(shutdown_event=asyncio.Event()))
    )
    monkeypatch.setattr(bootstrap, "create_app", lambda _settings: app)
    fake_socket_module = SimpleNamespace(
        AF_INET=bootstrap.socket.AF_INET,
        SOCK_STREAM=bootstrap.socket.SOCK_STREAM,
        SOL_SOCKET=bootstrap.socket.SOL_SOCKET,
        SO_REUSEADDR=bootstrap.socket.SO_REUSEADDR,
        socket=lambda *_args: Socket(),
    )
    monkeypatch.setattr(bootstrap, "socket", fake_socket_module)
    monkeypatch.setattr(bootstrap.uvicorn, "Config", lambda app, **kwargs: (app, kwargs))
    monkeypatch.setattr(bootstrap.uvicorn, "Server", FakeServer)
    await bootstrap.run(settings)
    assert settings.ready_file
    assert bootstrap.os.environ["AIVS_BOUND_PORT"] == "43210"


def test_main_reports_startup_failure(monkeypatch):
    monkeypatch.setattr(bootstrap, "parser", lambda: SimpleNamespace(parse_args=lambda: object()))

    def missing_token():
        raise RuntimeError("missing")

    monkeypatch.setattr(bootstrap, "admin_token_from_environment", missing_token)
    with pytest.raises(SystemExit, match="1"):
        bootstrap.main()
