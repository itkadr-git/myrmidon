---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Application module credentials can use secret references

- The stack release check GitHub token, the tracing ClickHouse password and the browser screen-console token can now be taken from a bound secret reference instead of a process environment variable. The value is resolved on the server only, per use, so a changed or revoked reference applies without a restart. An emergency environment variable still wins when set.
