## divergence-new

<!-- after: 1.6.6 — CORPUS-SHADOW A: теневой вызов модуля корпуса -->

### 1.7 — CI-WARNINGS: подавление предупреждений rustc в runner-core через cfg

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-CI-WARNINGS | Подавление четырёх rustc warning'ов при сборке runner-core на Linux: импорты `OpenOptions` (macos) и `fs` (macos/test), подавление unused_mut на двух `let` при компиляции не под macOS, ограничение `receive_plain` под `#[cfg(test)]`. `cargo fix` не применяется во избежание ломки сборки под macOS | `packages/paperclip-runner/runner/crates/runner-core/src/process_supervisor.rs`, `packages/paperclip-runner/runner/crates/runner-core/src/durable/transport.rs` | Чистая Linux-сборка `paperclip-runner-core` в CI без предупреждений компилятора | `cargo check --manifest-path runner/Cargo.toml --locked --workspace` и `--tests`; `cargo test --manifest-path runner/Cargo.toml -p paperclip-runner-core durable::transport` | Когда апстрим сам добавит корректные cfg-атрибуты для macos/test-кода | OPE-12642 |
