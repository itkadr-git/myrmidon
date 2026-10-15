# OPE-6419 LiteLLM worker-resize smoke test

This directory contains a repeatable load driver and a local OpenAI-compatible mock. The test sends `POST /chat/completions` requests while it signals a Gunicorn master to add and remove workers.

## Run

Requirements: Docker with permission to create containers and networks, and access to the configured LiteLLM image.

```sh
cd tests/litellm-workers
./run_load_test.sh
```

The runner uses one CPU and 3 GiB for LiteLLM, a mock backend with a 200 ms response delay, a 150 second duration, and a target of 8 requests per second. Override `LITELLM_IMAGE`, `DURATION`, and `RPS` as needed. It prints a JSON summary and stores request rows in `ope6419-results.jsonl`. Containers and the temporary network are removed on exit.

The Python driver can also run against an existing instance:

```sh
python3 load_test.py http://127.0.0.1:4000 <gunicorn-master-pid> [duration_s] [rps]
```

## Recorded stand result

The reported prior stand run used 8 RPS for 150 seconds and recorded 2,456 requests: 2,456 HTTP 200, zero 5xx, zero timeouts, and zero connection resets. Median latency was 224 ms with two workers and 225 ms with four workers. The run reported the TTIN/TTOU worker sequence 2 -> 4 -> 2. These are historical measurements supplied in the OPE-6419 task thread; this commit does not rerun or independently validate that stand test.

## Limitations

The container runner's process signal path and compatibility with the selected LiteLLM image must be confirmed in the target Docker environment. This script is a smoke-test aid, not proof of production behavior. Do not use production credentials or endpoints.
