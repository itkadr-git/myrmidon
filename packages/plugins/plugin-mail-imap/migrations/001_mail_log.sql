CREATE TABLE plugin_mail_imap_66578f214c.mail_log (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  uid integer NOT NULL,
  message_id text,
  from_header text,
  subject text,
  source_folder text NOT NULL,
  target_folder text,
  rule_name text,
  status text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mail_log_company_created_idx
  ON plugin_mail_imap_66578f214c.mail_log (company_id, created_at DESC);

CREATE TABLE plugin_mail_imap_66578f214c.sync_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  trigger text NOT NULL,
  fetched integer NOT NULL DEFAULT 0,
  moved integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  cursor_before integer NOT NULL DEFAULT 0,
  cursor_after integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX sync_runs_company_started_idx
  ON plugin_mail_imap_66578f214c.sync_runs (company_id, started_at DESC);
