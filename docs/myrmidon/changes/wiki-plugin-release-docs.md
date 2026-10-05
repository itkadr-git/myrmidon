## changelog-en

### LLM Wiki plugin install/upgrade guide and release wiring test (WIKI-PLUGIN-RELEASE)

- `docs/wiki-plugin-install-guide.md` — installation, folder configuration,
  upgrade and troubleshooting steps for `@paperclipai/plugin-llm-wiki`.
- `scripts/myrmidon/wiki-plugin/wiki-plugin-release.test.mjs` — static
  `node:test` contract that pins the plugin's release wiring (esbuild build
  script, SDK from the repository workspace, `paperclipPlugin` entry points,
  packaged file list, esbuild config, guide presence) inside the cheap
  `checks` tier, without running a build.

## changelog-ru

### Руководство по установке плагина LLM Wiki и тест релизного контура (WIKI-PLUGIN-RELEASE)

- `docs/wiki-plugin-install-guide.md` — установка, настройка каталога вики,
  обновление и диагностика `@paperclipai/plugin-llm-wiki`.
- `scripts/myrmidon/wiki-plugin/wiki-plugin-release.test.mjs` — статический
  контракт `node:test`, закрепляющий релизную обвязку плагина (сборочный
  скрипт esbuild, SDK из воркспейса репозитория, точки входа
  `paperclipPlugin`, список упакованных файлов, конфиг esbuild, наличие
  руководства) в дешёвом тире `checks`, без сборки.