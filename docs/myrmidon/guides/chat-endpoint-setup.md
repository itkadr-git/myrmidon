# Chat endpoint setup and verification

The chat endpoint detail page shows the current setup state and the actions
that are safe for that state.

## Finish setup for verifying endpoints

When an endpoint has status `verifying` and `setup.step` is `test`, the detail
page shows a direct **Finish setup** action. The action uses the existing
`POST /api/chat-endpoints/:endpointId/test` route. It does not create a second
completion route or silently skip the server-side checks.

The button is disabled while the request is running. After a successful
completion, the detail query is invalidated so the page shows the new endpoint
status and does not offer the action again.

If the server returns `409` with code
`chat_test_round_trip_incomplete`, the endpoint remains in its current state.
The page tells the operator to wait for the agent response to the test dialog.
The existing **Finish setup** path to the setup wizard remains available so the
operator can continue setup or retry the test.

## Stale verifying signal

When the API response contains `verifyingStale: true`, the detail page shows a
non-destructive attention badge: **Verifying over 24 hours with live traffic**.
This is an attention signal, not an error, and it does not change endpoint
state or stop traffic. The badge is absent when the server does not set the
flag.

The flag is supplied by the server for endpoint detail and list responses. The
UI treats it as optional so older responses remain valid.

## Accessibility and action states

The action uses a real button with a visible label. During mutation it remains
disabled and shows a progress indicator. The attention badge uses the regular
non-destructive badge treatment; it is not styled as a failure or destructive
action.
