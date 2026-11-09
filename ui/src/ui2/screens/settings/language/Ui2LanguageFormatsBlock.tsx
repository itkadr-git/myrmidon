import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../../api/client";
import { instanceSettingsApi } from "../../../../api/instanceSettings";
import { queryKeys } from "../../../../lib/queryKeys";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2Section } from "../../../components/ui2Primitives";
import type { InstanceDateFormat, InstanceNumberFormat, InstanceGeneralSettings } from "@myrmidon/shared";

type SettingsPatch = Partial<Pick<InstanceGeneralSettings, "timeZone" | "numberFormat" | "dateFormat">>;

const timeZones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
const FALLBACKS = { timeZone: "Asia/Irkutsk", numberFormat: "en-US" as InstanceNumberFormat, dateFormat: "ymd" as InstanceDateFormat };
const PREVIEW_INSTANT = new Date("2026-10-31T01:00:00.000Z");

function formatPreviewDateTime(timeZone: string, dateFormat: InstanceDateFormat) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(PREVIEW_INSTANT);
    const map: Record<string, string> = {};
    for (const part of parts) {
      map[part.type] = part.value;
    }
    const { year = "2026", month = "10", day = "31", hour = "09", minute = "00" } = map;
    const dateStr = dateFormat === "dmy"
      ? `${day}.${month}.${year}`
      : dateFormat === "mdy"
      ? `${month}/${day}/${year}`
      : `${year}-${month}-${day}`;
    return `${dateStr} ${hour}:${minute}`;
  } catch {
    const fallbackDate = dateFormat === "dmy" ? "31.10.2026" : dateFormat === "mdy" ? "10/31/2026" : "2026-10-31";
    return `${fallbackDate} 09:00`;
  }
}

export function Ui2LanguageFormatsBlock() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: () => instanceSettingsApi.getGeneral() });
  const settings = query.data;
  const [draft, setDraft] = useState<SettingsPatch>({});
  const [search, setSearch] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: SettingsPatch) => instanceSettingsApi.updateGeneral(patch),
    onSuccess: (next) => { queryClient.setQueryData(queryKeys.instance.generalSettings, next); setDraft({}); setFieldError(null); },
    onError: (error) => { if (error instanceof ApiError && error.status === 400) setFieldError(error.message); },
  });
  const values = { ...FALLBACKS, ...settings, ...draft };
  const filteredZones = useMemo(() => timeZones.filter((zone) => zone.toLowerCase().includes(search.toLowerCase())), [search]);
  const preview = new Intl.NumberFormat(values.numberFormat).format(1234.56) + " · " + formatPreviewDateTime(values.timeZone, values.dateFormat);
  const setValue = (key: keyof SettingsPatch, value: string) => setDraft((current) => ({ ...current, [key]: value } as SettingsPatch));
  const source = (key: keyof SettingsPatch) => draft[key] !== undefined ? t("ui2.settings.language.formats.source.pending") : settings?.[key] !== undefined ? t("ui2.settings.language.formats.source.settings") : t("ui2.settings.language.formats.source.default");

  if (query.isLoading) return <Ui2Section title={t("ui2.settings.language.formats.title")}><p>{t("ui2.common.loading")}</p></Ui2Section>;
  return <Ui2Section title={t("ui2.settings.language.formats.title")}>
    <div className="space-y-4">
      <label className="block text-sm"><span>{t("ui2.settings.language.formats.timeZone")}</span> <span className="text-xs text-muted-foreground">({source("timeZone")})</span>
        <input className="mt-1 block w-full rounded-md border border-border bg-background p-2" value={search} placeholder={t("ui2.settings.language.formats.timeZonePlaceholder")} onChange={(event) => setSearch(event.target.value)} onBlur={() => { if (search && timeZones.includes(search)) setValue("timeZone", search); }} />
        <select className="mt-1 block w-full rounded-md border border-border bg-background p-2" value={values.timeZone} onChange={(event) => { setValue("timeZone", event.target.value); setFieldError(null); }}>{filteredZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select>
        {fieldError && <span className="text-sm text-destructive">{fieldError}</span>}
      </label>
      <label className="block text-sm"><span>{t("ui2.settings.language.formats.numberFormat")}</span> <span className="text-xs text-muted-foreground">({source("numberFormat")})</span>
        <select className="mt-1 block rounded-md border border-border bg-background p-2" value={values.numberFormat} onChange={(event) => setValue("numberFormat", event.target.value as InstanceNumberFormat)}><option value="en-US">{t("ui2.settings.language.formats.numberFormatEnUs")}</option><option value="ru-RU">{t("ui2.settings.language.formats.numberFormatRuRu")}</option></select>
      </label>
      <label className="block text-sm"><span>{t("ui2.settings.language.formats.dateFormat")}</span> <span className="text-xs text-muted-foreground">({source("dateFormat")})</span>
        <select className="mt-1 block rounded-md border border-border bg-background p-2" value={values.dateFormat} onChange={(event) => setValue("dateFormat", event.target.value as InstanceDateFormat)}><option value="ymd">{t("ui2.settings.language.formats.dateFormatYmd")}</option><option value="dmy">{t("ui2.settings.language.formats.dateFormatDmy")}</option><option value="mdy">{t("ui2.settings.language.formats.dateFormatMdy")}</option></select>
      </label>
      <p className="rounded-md border border-border p-3 text-sm"><strong>{t("ui2.settings.language.formats.preview")}</strong>: {preview}</p>
      <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" disabled={!Object.keys(draft).length || mutation.isPending} onClick={() => mutation.mutate(draft)}>{t("ui2.common.save")}</button>
    </div>
  </Ui2Section>;
}
