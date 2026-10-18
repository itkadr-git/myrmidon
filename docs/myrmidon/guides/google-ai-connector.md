# Google AI Pro: owner guide

> Russian version: [google-ai-connector.ru.md](google-ai-connector.ru.md)

This guide describes the Google AI Pro settings page currently implemented in
this fork (C1). It is distinct from the newer account-pool plugin documented
in the private deployment repository; use the UI actually installed on your
board.

## Before connecting

Read the Google terms disclosure shown above the connection controls. The
bridge uses an owner-provided Google session and is not an official Google API
integration. The disclosure summarizes the account, policy, and privacy risks;
do not connect an account unless your organization accepts them. Never paste
session cookies into chat, tickets, source control, or screenshots.

## Connect or reconnect

1. Open the company settings page **Google AI Pro**.
2. Read the disclosure at the top of the page.
3. Follow the on-screen sign-in instructions to obtain the session cookie JSON.
   Paste it into the session field. Do not save or share the value elsewhere.
4. Select **Connect**. For an existing connection, use **Reconnect** with a
   fresh session. The field is write-only; the board does not display the
   stored value again.
5. Check the connection status and bridge health. **Check now** refreshes the
   health check; **Disconnect** removes the connection.

The settings page can also run a trial image generation. Enter a prompt and
select the trial action; successful image paths are shown in the result area.
The generated files are stored in the caller's agent workspace, not embedded
in the board page.

## Status and health

| Display | Meaning |
| --- | --- |
| Not connected | No company session has been connected. |
| Connected | The connector reports an active connection. |
| Stale | The Google session needs owner attention; reconnect with a fresh session. |
| Error | The last connection check reported an error; inspect the displayed error and check again. |
| Bridge unavailable | The bridge health endpoint could not be read. This is not proof that the session is valid. |

Health shows session state, image/video quota counters when supplied by the
bridge, pause state, bridge version, and the configured video delivery mode.
Quota figures are bridge estimates, not a promise of Google's remaining
allowance. With delivery mode `off`, video generation is unavailable.

## Grant agent access

In the **Grants** section, choose a capability (`generate_image`,
`creative_text`, or `generate_video`) and a target: an individual agent, a
caste/role, or everyone. Supply the agent ID or caste when requested, then add
the grant. Review the list and remove grants that are no longer needed. Keep
video ungranted unless the deployment explicitly enables it.

## Use Gemini as an agent model

The C1b bridge exposes a dynamic OpenAI-compatible model list at `/v1/models`
from the live subscription session. The C1 settings screen does not configure
a provider or select the model; this requires registration in the board model
catalog and agent/role model controls from C1/C3 deployment. If configured,
select the subscription provider/model in agent or role settings. This differs
from `creative_text`: model selection routes the agent's text-generation
requests through Gemini, while `creative_text` is an explicit tool call. The
bridge rejects `stream:true` with HTTP 501 `not_implemented`; streaming is
unsupported. The Google model name is visible in run/provider details only if
the deployed board version exposes it; the C1 settings page itself does not
show which model answered a turn.

If the session expires, `/v1/models` reports `401 session_stale`; model
completion requests can fail with the same session error. Automatic fallback
to the previous model is not specified: inspect the failed run and explicitly
select a working model before retrying. Tool calls can report
`session_stale`, `quota_exceeded`, `quota_paused`, or `quota_refused`; surface
the error to the owner and do not retry in a loop.

## Related

- [External MCP connectors](external-mcp-connectors.md) — generic connection
  and agent-access concepts.
- [1.6.6 Google AI change notes](../changes/1-6-6-google-ai-connect-ui.md) —
  implementation-specific details.