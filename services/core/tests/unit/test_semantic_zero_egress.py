"""A6 零 egress（ADR-0003 D4 硬承诺）—— 机器可断言。

为什么必须单独测：门 §3 A6 要求「全链路无外发」。语义检索引入了一个
**会下载模型**的 provider，这是本仓第一次有推理链路自带网络获取能力；
若模型下载之外的路径偷偷外发（telemetry、远程校验等），只有测试能拦住。

做法：在 socket 层拦截，断言「推理期间零连接尝试」。
负向对照：显式发起一次连接，用例必须变红（证明拦截器有效，不是恒真）。
"""
from __future__ import annotations

import socket
from unittest import mock

import numpy as np
import pytest

from aivs_core.media.semantic import aggregate_embeddings, cosine_rank, l2_normalize


class _NetGuard:
    """记录一切 socket 连接尝试；可选地阻止它们。"""

    def __init__(self) -> None:
        self.attempts: list[tuple] = []
        self._orig_connect = socket.socket.connect
        self._orig_connect_ex = socket.socket.connect_ex
        self._orig_create = socket.create_connection

    def __enter__(self):
        attempts = self.attempts

        def connect(sock_self, address):
            attempts.append(('connect', address))
            return None  # 不真正建连，避免测试依赖网络

        def connect_ex(sock_self, address):
            attempts.append(('connect_ex', address))
            return 0

        def create_connection(address, *a, **kw):
            attempts.append(('create_connection', address))
            raise OSError('blocked by test')

        socket.socket.connect = connect
        socket.socket.connect_ex = connect_ex
        socket.create_connection = create_connection
        return self

    def __exit__(self, *exc):
        socket.socket.connect = self._orig_connect
        socket.socket.connect_ex = self._orig_connect_ex
        socket.create_connection = self._orig_create
        return False


class TestZeroEgress:
    def test_pure_algorithms_make_no_network_calls(self):
        """A6：纯算法层（归一/聚合/排序）零网络。"""
        with _NetGuard() as guard:
            v = l2_normalize(np.array([3.0, 4.0]))
            agg = aggregate_embeddings([v, v])
            cosine_rank(agg, [('a', v), ('b', np.array([0.0, 1.0]))], k=2)
        assert guard.attempts == [], f'纯算法层出现外发尝试: {guard.attempts}'

    def test_negative_control_guard_actually_catches_connections(self):
        """负向对照：拦截器必须能捕获真实连接尝试，否则上面的断言恒真。"""
        with _NetGuard() as guard:
            s = socket.socket()
            try:
                s.connect(('203.0.113.1', 80))  # TEST-NET-3，不会被真的连
            except OSError:
                pass
            finally:
                s.close()
        assert guard.attempts, '拦截器未捕获连接——A6 断言将恒真'

    def test_model_path_resolution_does_not_hit_network(self, tmp_path):
        """A6：模型路径解析（未安装分支）不得触发下载。"""
        from aivs_core.database import Database
        from aivs_core.media.semantic_service import SemanticIndexService

        db = Database(tmp_path / 't.db')
        db.initialize()
        svc = SemanticIndexService(db, ffmpeg=tmp_path / 'ffmpeg', model_manager=None)
        with _NetGuard() as guard:
            result = svc._model_paths()
        assert result == (None, None)
        assert guard.attempts == [], f'模型解析出现外发: {guard.attempts}'

    def test_search_does_not_hit_network(self, tmp_path):
        """A6：检索（空库）零网络。"""
        from aivs_core.database import Database
        from aivs_core.media.semantic_service import SemanticIndexService

        db = Database(tmp_path / 't2.db')
        db.initialize()
        svc = SemanticIndexService(db, ffmpeg=tmp_path / 'ffmpeg', model_manager=None)
        with _NetGuard() as guard:
            hits = svc.search('proj_missing', np.array([1.0, 0.0]), limit=5)
        assert hits == []
        assert guard.attempts == [], f'检索出现外发: {guard.attempts}'
