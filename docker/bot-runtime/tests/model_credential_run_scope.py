import asyncio
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from gateway.platforms import api_server_runs


async def main():
    adapter = APIServerAdapter(PlatformConfig(enabled=True))
    app = web.Application()
    app.router.add_post("/v1/runs", adapter._handle_runs)
    received = []

    async def capture(_adapter, launch, *, _api_server):
        received.append(launch.model_credential)

    with patch.object(api_server_runs, "_execute_run", capture):
        async with TestClient(TestServer(app)) as client:
            for credential in ("run-key-one", "run-key-two"):
                response = await client.post("/v1/runs", json={
                    "input": "hello", "model_credential": {"api_key": credential},
                })
                assert response.status == 202, await response.text()
                await asyncio.sleep(0)
    assert received == ["run-key-one", "run-key-two"]
    print("model credential run-scope regression: ok")


if __name__ == "__main__":
    asyncio.run(main())
