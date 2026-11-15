# Agents Fleet in UI-2

> Русская версия: [Ui2-agents-fleet.ru](Ui2-agents-fleet.ru)


The UI-2 Agents Fleet screen is available at `/{company}/agents` and uses the company-scoped agents API. It shows each agent's name and role, its status (idle, running, or error), and its latest live run when one exists. Agents are nested according to `reportsTo`; a scroll container keeps long fleets usable on desktop and mobile. Selecting an agent opens its detail/chat page. The destination appears once in desktop and phone navigation as "Agents" (the "Servers" item opens the separate `/fleet` hosts and services screen). When no agents are configured, the page shows a localized empty state.

The screen polls agents every 30 seconds and live runs every 15 seconds. Run data is requested with a bounded `minCount=50&limit=100` query rather than the full heartbeat history.

When an agent reports `paused`, the UI preserves that API state as a distinct status rather than relabeling it as idle.
