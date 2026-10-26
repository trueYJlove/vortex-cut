from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from . import __version__


def _resource_path(name: str) -> Path:
    configured_root = os.environ.get("AIVS_RESOURCE_ROOT")
    bundle_root = getattr(sys, "_MEIPASS", None)
    executable_root = Path(sys.executable).resolve().parent
    candidates = [
        Path(configured_root).expanduser() if configured_root else None,
        Path(bundle_root) if bundle_root else None,
        executable_root / "_internal",
        executable_root,
        Path.cwd().resolve() / "resources",
        Path.cwd().resolve(),
    ]
    roots = [candidate.resolve() for candidate in candidates if candidate is not None]
    for root in roots:
        path = root / name
        if path.exists():
            return path
    return roots[0] / name


DEFAULT_MANIFEST_DIR = _resource_path("model-manifests")
DEFAULT_FONT_DIR = _resource_path("fonts")
DEFAULT_RECIPE_DIR = _resource_path("recipes")


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 0
    data_dir: Path = Path(".aivideo")
    ffmpeg: Path = Path("ffmpeg")
    ffprobe: Path = Path("ffprobe")
    parent_pid: int | None = None
    runtime_dir: Path | None = None
    build_version: str = __version__
    log_level: str = "info"
    ready_file: Path | None = None
    manifest_dir: Path = field(default_factory=lambda: _resource_path("model-manifests"))
    font_dir: Path = field(default_factory=lambda: _resource_path("fonts"))
    recipe_dir: Path = field(default_factory=lambda: _resource_path("recipes"))
    image_provider_network_enabled: bool = False
    # Provider 代理（PROXY_SUPPORT 规划门 2026-09-20）：None = 未配置（按
    # proxy_mode 解析）；显式 URL = 自定义代理。解析三级回退见 resolve_proxy。
    provider_proxy: str | None = None
    proxy_mode: str = "system"  # system | custom | direct

    def prepare(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "jobs").mkdir(exist_ok=True)
        (self.data_dir / "backups").mkdir(exist_ok=True)
        (self.data_dir / "projects").mkdir(exist_ok=True)
        if self.runtime_dir:
            self.runtime_dir.mkdir(parents=True, exist_ok=True)

    @property
    def database_path(self) -> Path:
        return self.data_dir / "app.db"

    @classmethod
    def from_args(cls, args: object) -> Settings:
        manifest_dir = getattr(args, "manifest_dir", None)
        recipe_dir = getattr(args, "recipe_dir", None)
        return cls(
            host=getattr(args, "host"),
            port=getattr(args, "port"),
            data_dir=Path(getattr(args, "data_dir")),
            ffmpeg=Path(getattr(args, "ffmpeg")),
            ffprobe=Path(getattr(args, "ffprobe")),
            parent_pid=getattr(args, "parent_pid"),
            runtime_dir=Path(getattr(args, "runtime_dir"))
            if getattr(args, "runtime_dir", None)
            else None,
            log_level=getattr(args, "log_level"),
            ready_file=Path(getattr(args, "ready_file"))
            if getattr(args, "ready_file", None)
            else None,
            manifest_dir=(
                Path(manifest_dir) if manifest_dir else _resource_path("model-manifests")
            ),
            recipe_dir=Path(recipe_dir) if recipe_dir else _resource_path("recipes"),
            image_provider_network_enabled=bool(
                getattr(args, "enable_image_provider_network", False)
            ),
            provider_proxy=getattr(args, "provider_proxy", None),
            proxy_mode=getattr(args, "proxy_mode", "system"),
        )


def admin_token_from_environment() -> str:
    token = os.environ.get("AIVS_ADMIN_TOKEN", "")
    if not token:
        raise RuntimeError("AIVS_ADMIN_TOKEN is required")
    return token


def proxy_display_value(proxy: str | None) -> str | None:
    """代理 URL → 可安全回显的 scheme://host:port（其余一律丢弃）。

    为什么需要清洗：出错消息要带代理上下文（PROXY_SUPPORT 规划门 §4——"代理
    指向不可用端口"与"直连失败"必须让用户能区分），但这些消息会落库
    （provider_image_invocations.error_message / jobs.error_message）并进入 Core
    DTO，因此只能回显 scheme+host+port：url 里的凭据段（user:pass@）、查询串、
    路径都不是可回显内容（认证代理本就是 v1 明确不做项，见门 §1）。解析不出
    host 时返回 None——宁可丢上下文，也不原样回显未校验字符串。
    """
    if not proxy:
        return None
    try:
        parsed = urlparse(proxy)
        host = parsed.hostname
        if not host:
            return None
        scheme = parsed.scheme or "http"
        return f"{scheme}://{host}:{parsed.port}" if parsed.port else f"{scheme}://{host}"
    except ValueError:
        # 端口段非法（.port 在非数字/越界时抛 ValueError）
        return None


def resolve_provider_proxy(settings: "Settings") -> str | None:
    """Provider 代理三级回退（PROXY_SUPPORT 规划门 §1）。

    custom：显式 provider_proxy 值；direct：None（强制直连）；
    system（默认）：Windows 读注册表 Internet Settings（ProxyEnable/
    ProxyServer），读取失败静默回退直连（代理是优化不是依赖）。
    """
    if settings.proxy_mode == "custom":
        return settings.provider_proxy or None
    if settings.proxy_mode == "direct":
        return None
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ) as key:
                enabled = winreg.QueryValueEx(key, "ProxyEnable")[0]
                if not enabled:
                    return None
                server = str(winreg.QueryValueEx(key, "ProxyServer")[0])
                if "=" not in server and server:
                    # 形如 127.0.0.1:10809（无协议前缀）——httpx 需要 scheme
                    return f"http://{server}"
                # 形如 http=...;https=...：**先**取 https 段。此前按分号顺序逐段匹配并
                # 立即返回，第一段就是 http 段，于是 https 段永远取不到——而 Provider
                # 出网是 HTTPS，走了 http 段等于白绕一圈（多数代理仍会 CONNECT，
                # 所以表现为偶发超时而非明确报错，最难查）。
                segments = dict(
                    part.split("=", 1) for part in server.split(";") if "=" in part
                )
                chosen = segments.get("https") or segments.get("http")
                if not chosen:
                    return f"http://{server}" if server else None
                # 这里必须补 scheme。旧写法直接返回分段值（127.0.0.1:10809），而
                # httpx.AsyncClient(proxy=...) 对无 scheme 的值抛 ValueError，且该
                # 异常发生在 Provider 调用时、不在 providers.py 捕获的网络异常家族
                # 里——用户看到的是 500 内部错误而非网络错误，根因（代理）彻底丢失。
                return chosen if "://" in chosen else f"http://{chosen}"
        except OSError:
            return None
    return None
