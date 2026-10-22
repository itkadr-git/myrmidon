# ADR-0032: Свой RAG на TypeScript — модулем продукта, открытый

- Status: accepted
- Date: 2026-10-04
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-10-04-own-rag-module`)

## Decision

свой RAG на TypeScript внутри продукта делаем, но может модулем?

## Consequences

Принято: свой RAG на TS, оформляется модулем продукта (отдельный пакет за портами ядра CorpusStore/SearchIndex/WorkQueue/BlobStore, включается/настраивается в UI). Модуль открытый (открытое ядро MIT) — ответ владельца «Открытый». Haystack и Mastra как основа — нет. RAGFlow 0.27 держать до переключения, на 1.0 не обновлять.
