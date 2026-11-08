---
'@myrmidon/server': patch
---

Corpus search: batch document-title lookup and cut the handler's per-request overhead. One search resolved every hit's document with `getDocument`, which also loads each document's chunks (embeddings included) and parse jobs, and the dataset existence check loaded every document of the dataset with the same weight; both now go through one bounded company-scoped query (`getDocumentNames`, `hasDataset`), and the search handler and the search index log their step durations (`corpus search: handler step timings`, `corpus search: embed and index timings`) on the debug log so a slow stand search can be attributed to the embedding call vs the SQL.
