# syntax=docker/dockerfile:1.20
#
# Myrmidon REDACT service: sensitive data masking, entity detection, and guardrails.
#   target `test`     unit tests and synthetic benchmarks
#   target `service`  HTTP and MCP server

FROM python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src PATH=/opt/venv/bin:$PATH
RUN python -m venv /opt/venv \
 && groupadd --gid 10001 redact && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin redact
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY src /app/src
WORKDIR /app

FROM base AS test
COPY tests /app/tests
RUN python -m unittest discover -s tests -v

FROM base AS service
LABEL org.opencontainers.image.title="Myrmidon REDACT"
LABEL org.opencontainers.image.description="Sensitive data masking and guardrails service"
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "myrmidon_redact"]
CMD ["--http", "--port", "8080"]
