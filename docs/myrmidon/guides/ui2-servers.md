# UI2 "Servers" screen (/fleet)

> Russian version: [ui2-servers.ru.md](ui2-servers.ru.md)

The "Servers" screen (`/fleet`) shows the live state of the hosts, services and
remote sites the deployment runs on. The data comes from the monitoring
dashboard API (`/api/myrmidon/monitoring/dashboard`); how to connect the
sources is described in [fleet-dashboard-monitoring.md](fleet-dashboard-monitoring.md).

## What the screen shows

- **Sites** (when configured): the state of each remote execution site and when it was last seen.
- **Hosts**: CPU, memory and disk load per host.
- **Services**: running or stopped state of each container.

## Monitoring errors

When monitoring is not configured or is unavailable, the screen says so above
the lists instead of "No fleet resources yet". The message is shown when the
dashboard answers `ok=false`, or when any source reports an `error`. The error
text of each source is listed under the message; if no source gave a text, the
screen shows "Monitoring data is unavailable." The empty state is shown only
when monitoring is healthy and there is genuinely nothing to list.

While no company is selected the screen keeps its loading skeleton.

## In the menu

The menu has two items: "Agents" (`/agents`) and "Servers" (`/fleet`). On the
phone tab bar, `/agents` highlights only "Agents", not "More".
