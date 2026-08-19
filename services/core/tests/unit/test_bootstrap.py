import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from aivs_core import bootstrap
from aivs_core.config import DEFAULT_MANIFEST_DIR, Settings, _resource_path


def test_parser_defaults_and_arguments():
    args = bootstrap.parser().parse_args(["--port", "1234", "--data-dir", "data"])
    assert args.host == "127.0.0.1"
    assert args.port == 1234
    assert args.data_dir == "data"


def test_image_provider_network_is_explicit_and_fail_closed() -> None:
    default = Settings.from_args(bootstrap.parser().parse_args([]))
    enabled = Settings.from_args(bootstrap.parser().parse_args(["--enable-image-provider-network"]))
    assert default.image_provider_network_enabled is False
    assert enabled.image_provider_network_enabled is True


def test_settings_from_args_uses_default_or_explicit_manifest_dir(tmp_path: Path):
    default_settings = Settings.from_args(bootstrap.parser().parse_args([]))
    explicit_manifest_dir = tmp_path / "manifests"
    explicit_settings = Settings.from_args(
        bootstrap.parser().parse_args(["--manifest-dir", str(explicit_manifest_dir)])
    )

    assert default_settings.manifest_dir == DEFAULT_MANIFEST_DIR
    assert explicit_settings.manifest_dir == explicit_manifest_dir


def test_resource_path_uses_source_resource_root(tmp_path: Path, monkeypatch) -> None:
    resources = tmp_path / "resources" / "model-manifests"
    resources.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("AIVS_RESOURCE_ROOT", raising=False)
    monkeypatch.delattr("sys._MEIPASS", raising=False)

    assert _resource_path("model-manifests") == resources.resolve()
    assert Settings().manifest_dir == resources.resolve()


def test_resource_path_prefers_pyinstaller_bundle(tmp_path: Path, monkeypatch) -> None:
    bundle = tmp_path / "bundle"
    manifests = bundle / "model-manifests"
    fonts = bundle / "fonts"
    manifests.mkdir(parents=True)
    fonts.mkdir()
    monkeypatch.setattr("sys._MEIPASS", str(bundle), raising=False)
    monkeypatch.chdir(tmp_path)

    settings = Settings()
    assert settings.manifest_dir == manifests.resolve()
    assert settings.font_dir == fonts.resolve()


def test_resource_path_prefers_explicit_resource_root(tmp_path: Path, monkeypatch) -> None:
    resource_root = tmp_path / "packaged-resources"
    manifests = resource_root / "model-manifests"
    manifests.mkdir(parents=True)
    monkeypatch.setenv("AIVS_RESOURCE_ROOT", str(resource_root))

    assert _resource_path("model-manifests") == manifests.resolve()


def test_pyinstaller_spec_collects_asr_runtime_and_resources() -> None:
    spec = Path("services/core/aivs-core.spec").read_text(encoding="utf-8")
    for package in (
        "faster_whisper",
        "ctranslate2",
        "tokenizers",
        "huggingface_hub",
        "av",
        "onnxruntime",
    ):
        assert f'"{package}"' in spec
    assert "collect_all" in spec
    assert '"model-manifests"' in spec
    assert '"fonts"' in spec


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
