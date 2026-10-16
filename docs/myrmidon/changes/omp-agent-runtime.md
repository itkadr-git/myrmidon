---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Add a pinned omp agent runtime image (OPE-7290)

- Add a CI-published, non-root omp runtime image with Bun 1.4.3 and `@oh-my-pi/pi-coding-agent` 18.9.2 matching the adapter version in Part A. The image smoke-checks `omp --version`, `bun --version`, `command -v omp`, `omp --help`, and `omp models ls` without contacting a model provider, and validates adapter execution alignment.

## changelog-ru

### Добавлен закреплённый образ агента omp (OPE-7290)

- Добавлен публикуемый CI непривилегированный образ omp с Bun 1.4.3 и `@oh-my-pi/pi-coding-agent` 18.9.2, совпадающий по версии с адаптером из части A. Smoke-check проверяет `omp --version`, `bun --version`, `command -v omp`, `omp --help` и `omp models ls` без обращения к поставщику модели и подтверждает соответствие контракту адаптера.

## divergence

| OMP-IMAGE | Добавляем отдельный runtime-образ omp с точными версиями Bun и CLI, uid 1000, управляемым HOME и проверкой CLI при сборке | `+ docker/agent-runtime/Dockerfile.omp`, `+ docker/agent-runtime/buildx-bake.hcl`, `+ .github/workflows/agent-runtime-images.yml` | Адаптеру omp требуется воспроизводимая среда; публикация выполняется только CI с подписью digest | `scripts/myrmidon/omp-image.test.mjs` и smoke-check Dockerfile | Удалить omp target и CI lane вместе с этим фрагментом; проверить потребителей образа перед удалением | (этот PR) |
