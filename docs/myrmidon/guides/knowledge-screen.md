# Knowledge screen (read, search, revisions)

> Russian version: [knowledge-screen.ru.md](knowledge-screen.ru.md)

The **Knowledge** screen is available in the UI 2.0 shell when the instance
feature `enableMyrmidonUi2` is enabled. It is a read and review surface over
the company knowledge module: it does not replace the normal authoring and
approval workflow.

## Open the screen

Choose **Work → Knowledge**. The left rail also provides **Work →
Regulations**, which opens the regulations view within Autonomy.

The screen reads the company selected in the board header. A person without
company access receives the normal board access denial; it never exposes
another company's pages or sources.

## Read and search knowledge

- The tree groups pages by their knowledge space and nests a page below the
  slug path that contains it.
- Use the search field for full-text search. Semantic search remains a UI
  choice but uses the available knowledge search endpoint until a semantic
  backend is enabled.
- `[[slug]]`, `[[slug#anchor]]`, and `[[slug|label]]` links lead to another
  page. Links inside inline code or fenced code remain plain text.
- The page's source and backlink panels link to board tasks, decisions, runs,
  or an external pull request/URL when the stored reference can be resolved.
  An unresolvable source remains visible as text rather than becoming a broken
  link.

## Revisions and rollback

The **Revisions** section lists the append-only history and compares two
revisions line by line. Restoring a past revision creates a new revision; it
never rewrites history.

The action is shown only when the page's approval policy permits it. The UI
names the required approver:

- **A** — the agent is the carrier of the action;
- **O** — an operator or owner carries it.

The server remains authoritative. A disabled action, an out-of-date page, or
an unauthorized actor is refused by the API and does not change delivered
knowledge.

## Regulations

Regulations are grouped by caste. Each row shows its status, revision count,
and the actor who must approve it. Human-approved regulations expose approval
and rollback actions only when their `approver_kind` permits a human action;
agent-held actions are shown as a request rather than approved on an agent's
behalf.
