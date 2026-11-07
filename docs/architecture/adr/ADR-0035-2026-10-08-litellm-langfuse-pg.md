# ADR-0035: LiteLLM и Langfuse на общий PostgreSQL 18

- Status: accepted
- Date: 2026-10-08
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-10-08-litellm-langfuse-pg`)

## Decision

LiteLLM и Langfuse нужно перевести на общий PostgreSQL и старые удалить. RAGFlow до переезда не трогай

## Consequences

Уточнение Alex 08.10: RAGFlow не трогать только ДО ввода своей замены (свой RAG на PostgreSQL); после ввода замены RAGFlow выводится и удаляется. Задачи: OPE-6163.
