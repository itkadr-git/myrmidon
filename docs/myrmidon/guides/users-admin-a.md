# Admin-managed users: create, block, reset (1.7 USERS-ADMIN-UI A)

> Russian version: [users-admin-a.ru.md](users-admin-a.ru.md)

An instance administrator can create board users directly — with a login and
a password, or with a login and a one-time link the user follows to set their
own password — block and unblock them, and reset a forgotten password. This
is the server half of the feature (1.7 USERS-ADMIN-UI A); the board screens ship
separately. Self-registration is **off by default** and turns on only by an
explicit instance setting.

## Who may do it

Every mutating route requires the instance-admin actor (`assertInstanceAdmin`
— the same rule the instance settings page follows). The user list is
board-readable. The password-set token itself is the proof for the user
following the link: that one route needs no session.

## The API

All routes live under `/api/myrmidon/users-admin-a`:

| Route | Method | Who | What |
|---|---|---|---|
| `/users` | GET | board | Users with role, block state, synthetic-email flag |
| `/users` | POST | instance admin | Create a user (see below) |
| `/users/:id` | PATCH | instance admin | `blocked`, `reason`, `resetPassword` |
| `/password-set` | POST | the token itself | Consume the one-time link, set a new password |
| `/self-sign-up` | GET | board | The self-registration switch and its source |
| `/self-sign-up` | PATCH | instance admin | Flip the self-registration switch |

### Creating a user

`POST /users` with `username` (3–30 chars, letters/digits/dot/underscore),
an optional `email`, an optional `password`, and a `role` of
`instance_admin` or `member`:

- With a `password` — the account exists immediately; sign-in works right
  away.
- Without a `password` — the response carries a one-time
  `passwordSetLink` (`/api/myrmidon/users-admin-a/password-set?token=…`,
  valid 24h). The user opens it, picks a password, and the token dies.
- Without an `email` — the user gets the synthetic address
  `<username>@myr.local` (a reserved, non-routable namespace nothing mails)
  and signs in with the username through `POST /api/auth/sign-in/username`.
  Users with a real email keep signing in by email exactly as before.

Creation writes the Better Auth tables directly (`user`, `account` with the
`local:credential` issuer, `instance_user_roles`), in the vendor's own shape,
so sign-in flows through Better Auth's verification path — not a parallel
one.

### Blocking

`PATCH /users/:id` with `{"blocked": true, "reason": "…"}` closes every live
session of that user immediately (the `session` rows are deleted) and the
sign-in guard refuses new sessions with `403 USER_BLOCKED` — by email, by
username, on every sign-in path Better Auth has (the check rides the
`session.create.before` database hook). An admin cannot block themselves.
Unblocking is the same call with `false`.

### Password reset

`PATCH /users/:id` with `{"resetPassword": true}` revokes every outstanding
password-set token of the user and returns a fresh one-time
`passwordSetLink`. A reset never reveals or re-sets the password itself; the
user picks the new one through the link.

### The audit trail

Every mutation lands in the activity log (`instance.user.created`,
`instance.user.blocked`, `instance.user.unblocked`,
`instance.user.password_reset`, `instance.user.password_set`) with who did
what to whom, the role and password mode granted, and the block reason.

## The self-registration switch

Self-registration (`POST /api/auth/sign-up/email`) is **off by default**.
`GET /self-sign-up` reports the effective value and where it came from:

- `settings` — the instance explicitly enabled it (the PATCH route writes
  `instance_settings.general.authSelfSignUp`);
- `env` — the forced override `MYRMIDON_AUTH_SELF_SIGN_UP=true|false` wins
  over the stored value (a typo in the variable falls through to the next
  source rather than flipping the switch);
- `default` — nothing was set: off.

The gate reads the settings row live on every sign-up attempt, so flipping
the switch takes effect without a restart; the environment override is only
for an operator who must force the value.

## Where the data lives

- Users and credentials: the existing Better Auth tables (`user`, `account`,
  `session`), untouched in shape.
- The block list: `instance_settings.general.myrmidonAuthBlockedUsers` — a
  map of user id to `{blockedAt, blockedBy, reason}`, carried over every
  vendor general write.
- The password-set tokens: the new `user_password_set_tokens` table
  (sha256 of the raw token, issued-via, revocation history; the raw value is
  returned once and never stored).
