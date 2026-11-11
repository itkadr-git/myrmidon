import type { ReactElement, ReactNode } from "react";
import { Trans } from "react-i18next";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { i18n, useTranslation } from "@/i18n";

type LabFixtureKey =
  | "signed-out-private"
  | "signed-in-private"
  | "claiming"
  | "claim-error"
  | "claim-success"
  | "public-invite-only";

const fixtureLabels = (): Record<LabFixtureKey, string> => ({
  "signed-out-private": i18n.t("area.ux-labs.bootstrap-setup-ux-lab.fixtureLabel.signedOutPrivate"),
  "signed-in-private": i18n.t("area.ux-labs.bootstrap-setup-ux-lab.fixtureLabel.signedInPrivate"),
  claiming: i18n.t("area.ux-labs.bootstrap-setup-ux-lab.fixtureLabel.claiming"),
  "claim-error": i18n.t("area.ux-labs.bootstrap-setup-ux-lab.fixtureLabel.claimError"),
  "claim-success": i18n.t("area.ux-labs.bootstrap-setup-ux-lab.fixtureLabel.claimSuccess"),
  "public-invite-only": i18n.t("area.ux-labs.bootstrap-setup-ux-lab.fixtureLabel.publicInviteOnly"),
});

const FIXTURE_ORDER: LabFixtureKey[] = [
  "signed-out-private",
  "signed-in-private",
  "claiming",
  "claim-error",
  "claim-success",
  "public-invite-only",
];

function CliFallback({ hasActiveInvite }: { hasActiveInvite: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{t("area.ux-labs.bootstrap-setup-ux-lab.cliFallback.title")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? t("area.ux-labs.bootstrap-setup-ux-lab.cliFallback.activeInvite")
          : t("area.ux-labs.bootstrap-setup-ux-lab.cliFallback.noInvite")}
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
{BOOTSTRAP_FALLBACK_COMMAND}
      </pre>
    </div>
  );
}

function StateChrome({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">{children}</Card>
    </div>
  );
}

function SignedOutPrivate() {
  const { t } = useTranslation();
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.finishTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.signedOut.description")}
      </p>
      <div className="mt-5">
        <Button asChild>
          <a href="/auth?next=/">{t("area.ux-labs.bootstrap-setup-ux-lab.signedOut.signInCta")}</a>
        </Button>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function SignedInPrivate() {
  const { t } = useTranslation();
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.finishTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.claimDescription")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{t("area.ux-labs.bootstrap-setup-ux-lab.claimCta")}</Button>
        <span className="text-sm text-muted-foreground">
          {t("area.ux-labs.bootstrap-setup-ux-lab.signedInAs")} <span className="font-medium text-foreground">{`jane@appliance.local`}</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.wrongAccount")}{" "}
        <a href="/auth?next=/" className="underline underline-offset-2">
          {t("area.ux-labs.bootstrap-setup-ux-lab.switchAccount")}
        </a>
        .
      </p>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimingPrivate() {
  const { t } = useTranslation();
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.finishTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.claimDescription")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled>
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
          {t("area.ux-labs.bootstrap-setup-ux-lab.claiming")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("area.ux-labs.bootstrap-setup-ux-lab.signedInAs")} <span className="font-medium text-foreground">{`jane@appliance.local`}</span>
        </span>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimErrorPrivate() {
  const { t } = useTranslation();
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.finishTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.claimDescription")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{t("area.ux-labs.bootstrap-setup-ux-lab.claimCta")}</Button>
        <span className="text-sm text-muted-foreground">
          {t("area.ux-labs.bootstrap-setup-ux-lab.signedInAs")} <span className="font-medium text-foreground">{`jane@appliance.local`}</span>
        </span>
      </div>
      <div
        role="alert"
        className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{t("area.ux-labs.bootstrap-setup-ux-lab.claimError.title")}</p>
          <p className="mt-1 text-destructive/90">
            <Trans
              i18nKey="area.ux-labs.bootstrap-setup-ux-lab.claimError.hint"
              components={{ path: <span className="font-mono" /> }}
            />
          </p>
        </div>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimSuccess() {
  const { t } = useTranslation();
  return (
    <StateChrome>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.success.title")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("area.ux-labs.bootstrap-setup-ux-lab.success.description")}
          </p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">{t("area.ux-labs.bootstrap-setup-ux-lab.success.redirecting")}</span>
      </div>
      <div className="mt-5">
        <Button asChild variant="outline">
          <a href="/">{t("area.ux-labs.bootstrap-setup-ux-lab.success.continue")}</a>
        </Button>
      </div>
    </StateChrome>
  );
}

function PublicInviteOnly() {
  const { t } = useTranslation();
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.publicInvite.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.publicInvite.description")}
      </p>
      <CliFallback hasActiveInvite />
      <p className="mt-4 text-xs text-muted-foreground">
        {t("area.ux-labs.bootstrap-setup-ux-lab.publicInvite.note")}
      </p>
    </StateChrome>
  );
}

const FIXTURE_BODIES: Record<LabFixtureKey, ReactElement> = {
  "signed-out-private": <SignedOutPrivate />,
  "signed-in-private": <SignedInPrivate />,
  claiming: <ClaimingPrivate />,
  "claim-error": <ClaimErrorPrivate />,
  "claim-success": <ClaimSuccess />,
  "public-invite-only": <PublicInviteOnly />,
};

export function BootstrapSetupUxLab() {
  const { t } = useTranslation();
  return (
    <div className="bg-background min-h-screen pb-16">
      <header className="border-b border-border bg-muted/20">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("area.ux-labs.bootstrap-setup-ux-lab.header.eyebrow")}</p>
          <h1 className="mt-1 text-2xl font-semibold">{t("area.ux-labs.bootstrap-setup-ux-lab.header.title")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.bootstrap-setup-ux-lab.header.description"
              components={{
                gate: <span className="font-mono" />,
                spec: <a className="underline underline-offset-2" href="/PAP/issues/PAP-10113" />,
                impl: <a className="underline underline-offset-2" href="/PAP/issues/PAP-10114" />,
                mode: <span className="font-mono" />,
                exposure: <span className="font-mono" />,
              }}
            />
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-12 px-6 pt-10">
        {FIXTURE_ORDER.map((key) => (
          <section key={key} aria-labelledby={`lab-${key}`}>
            <h2
              id={`lab-${key}`}
              className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              {fixtureLabels()[key]}
            </h2>
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/10 p-2">
              {FIXTURE_BODIES[key]}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
