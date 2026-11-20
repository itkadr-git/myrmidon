import asyncio
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, _ProviderAuthResolutionError
from gateway.platforms import api_server_runs


async def main():
    adapter = APIServerAdapter(PlatformConfig(enabled=True))
    app = web.Application()
    app.router.add_post("/v1/runs", adapter._handle_runs)
    received = []

    async def capture(_adapter, launch, *, _api_server):
        assert launch.model_credential not in repr(launch)
        received.append(launch.model_credential)

    with patch.object(api_server_runs, "_execute_run", capture):
        async with TestClient(TestServer(app)) as client:
            for malformed in ({}, {"api_key": ""}, {"api_key": 7}, {"api_key": "x", "extra": 1}):
                response = await client.post("/v1/runs", json={"input": "hello", "model_credential": malformed})
                assert response.status == 400
            for credential in ("run-key-one", "run-key-two"):
                response = await client.post("/v1/runs", json={
                    "input": "hello", "model_credential": {"api_key": credential},
                })
                assert response.status == 202, await response.text()
                await asyncio.sleep(0)
    assert received == ["run-key-one", "run-key-two"]

    from unittest.mock import MagicMock
    import gateway.run as gateway_run
    import run_agent
    import hermes_cli.tools_config as tools_config

    runtime = {"provider": "custom", "base_url": "http://gateway.invalid", "api_key": "old-key"}
    captured = []
    def make_agent(**kwargs):
        captured.append(kwargs)
        return MagicMock(model="test")

    with patch.object(gateway_run, "_resolve_runtime_agent_kwargs", side_effect=lambda: dict(runtime)), \
         patch.object(gateway_run, "_resolve_gateway_model", return_value="test"), \
         patch.object(gateway_run, "_load_gateway_config", return_value={}), \
         patch.object(gateway_run, "_checkpoint_agent_kwargs", return_value={}), \
         patch.object(gateway_run, "_current_max_iterations", return_value=1), \
         patch.object(gateway_run.GatewayRunner, "_load_reasoning_config", return_value=None), \
         patch.object(tools_config, "_get_platform_tools", return_value=[]), \
         patch.object(adapter, "_select_agent_runtime", side_effect=lambda kwargs, model, **kw: (model, None, None, None)), \
         patch.object(adapter, "_ensure_session_db", return_value=None), \
         patch.object(run_agent, "AIAgent", side_effect=make_agent):
        adapter._create_agent(run_model_credential="run-key-one")
        adapter._create_agent(run_model_credential="run-key-two")
        assert [entry["api_key"] for entry in captured] == ["run-key-one", "run-key-two"]
        assert all(entry["credential_pool"] is None and entry["fallback_model"] is None for entry in captured)
        assert runtime["api_key"] == "old-key"
        runtime["provider"] = "openai"
        try:
            adapter._create_agent(run_model_credential="run-key-three")
            raise AssertionError("native provider accepted gateway key")
        except _ProviderAuthResolutionError as exc:
            assert "configured custom gateway" in str(exc)
    print("model credential run-scope regression: ok")


if __name__ == "__main__":
    asyncio.run(main())
