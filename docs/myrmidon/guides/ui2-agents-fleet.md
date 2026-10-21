# Agents Fleet in UI-2

The UI-2 Agents Fleet screen is available at `/{company}/agents` and uses the company-scoped agents API. It shows each agent's name and role, its status (idle, running, or error), and its latest live run when one exists. Agents are nested according to `reportsTo`; a scroll container keeps long fleets usable on desktop and mobile. Selecting an agent opens its detail/chat page. The fleet destination appears once in desktop and phone navigation. When no agents are configured, the page shows a localized empty state.

The screen polls agents every 30 seconds and live runs every 15 seconds. Run data is requested with a bounded `minCount=50&limit=100` query rather than the full heartbeat history.

When an agent reports `paused`, the UI preserves that API state as a distinct status rather than relabeling it as idle.

## Флот агентов в UI-2

Экран «Флот агентов» UI-2 доступен по адресу `/{company}/agents` и использует API агентов с областью компании. Для каждого агента отображаются имя, роль, состояние (ожидание, выполняется или ошибка) и последний активный прогон, если он есть. Агенты сгруппированы по `reportsTo`; контейнер прокрутки упрощает работу с длинным списком на компьютере и телефоне. Выбор агента открывает страницу его карточки/чата. Переход к флоту присутствует по одному разу в навигации компьютера и телефона. Если агентов нет, показывается локализованное пустое состояние.

Экран обновляет данные агентов каждые 30 секунд, а активные прогоны — каждые 15 секунд. Запрос прогонов ограничен параметрами `minCount=50&limit=100`, вместо загрузки всей истории heartbeat. Статус «приостановлен» из API отображается отдельно, а не как «ожидание».
