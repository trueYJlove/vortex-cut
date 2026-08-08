import asyncio

import pytest

from aivs_core import bootstrap


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
