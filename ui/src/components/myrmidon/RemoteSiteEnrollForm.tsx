// myrmidon(1.6.6 REMOTE-SITES-T8): the form that adds a remote site from the board. The token and the
// certificates are company secrets: the form takes their names, never their values.
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import { buildEnrollBody, EMPTY_ENROLL_FORM, type EnrollBody, type EnrollFormValues } from "@/lib/remoteSites";

export interface RemoteSiteEnrollFormProps {
  pending?: boolean;
  /** The server's refusal, shown as received. */
  error?: string | null;
  doneName?: string | null;
  onSubmit: (body: EnrollBody) => void;
}

const FIELDS: Array<keyof EnrollFormValues> = [
  "name", "url", "tokenSecret", "maxCpus", "maxMemoryMb", "maxBots", "gatewayPortStart", "gatewayPortEnd",
];

export function RemoteSiteEnrollForm({ pending = false, error = null, doneName = null, onSubmit }: RemoteSiteEnrollFormProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EnrollFormValues>(EMPTY_ENROLL_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) {
    return <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t("remoteSites.form.open")}</Button>;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = buildEnrollBody(form);
    if (!result.ok) {
      setProblem(t(`remoteSites.form.problem.${result.problem}`, { field: t(`remoteSites.form.${result.field}`) }));
      return;
    }
    setProblem(null);
    onSubmit(result.body);
  };
  return (
    <form className="min-w-0 space-y-3" onSubmit={submit} data-testid="remote-site-enroll-form">
      <p className="text-xs text-muted-foreground">{t("remoteSites.form.hint")}</p>
      {FIELDS.map((field) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`remote-site-${field}`}>{t(`remoteSites.form.${field}`)}</Label>
          <Input id={`remote-site-${field}`} name={field} autoComplete="off" value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
        </div>
      ))}
      {problem ? <p className="text-sm text-destructive" role="alert" data-testid="remote-site-enroll-problem">{problem}</p> : null}
      {error ? <p className="text-sm text-destructive" role="alert">{t("remoteSites.actionFailed", { error })}</p> : null}
      {doneName ? <p role="status">{t("remoteSites.form.done", { name: doneName })}</p> : null}
      <Button type="submit" size="sm" disabled={pending}>{pending ? t("remoteSites.form.submitting") : t("remoteSites.form.submit")}</Button>
    </form>
  );
}
