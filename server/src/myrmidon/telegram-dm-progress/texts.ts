// server/src/myrmidon/telegram-dm-progress/texts.ts
//
// myrmidon(1.7-TG-LOCALE): the RU/EN catalog of the DM-PROGRESS status
// message — step labels ("читаю файл" / "reading file"), the working and
// queued fallbacks, the "Сделано:" header and the elapsed-time units.
// Labels are chosen by locale at RENDER time; a recorded step carries a kind
// (and its optional structured target), so the wording is never baked into
// the history. The ru column is byte-identical to the pre-catalog literals.
//
// Pure data. The locale type is structurally the bridge's `BridgeLocale`
// ("en" | "ru"); the module stays independent of agent-chat-bridge so the
// vendor-swept DM progress modules keep no bridge import.

/** The languages of the DM progress texts, matching the bridge locale. */
export type DmProgressTextLocale = "en" | "ru";

/** The step families the throttle compares ("did the work change kind?"). */
export type DmProgressStepKind =
  | "read"
  | "edit"
  | "shell"
  | "check"
  | "search_files"
  | "web_search"
  | "web_page"
  | "image"
  | "delegate"
  | "think"
  | "plan"
  | "memory"
  | "answer"
  | "tool";

/** One localized step label: the kind plus the full owner-language phrase. */
export interface DmProgressStepLabel {
  kind: DmProgressStepKind;
  label: string;
}

/** The provider-safe structured target of a read/edit step, if any. */
export type DmProgressTarget =
  | { type: "slides"; text: string }
  | { type: "document"; noun: string; basename: string }
  | { type: "file"; basename: string };

export interface DmProgressTexts {
  /** Fallback when the run has no steps yet and steps are shown. */
  working: string;
  /** The queued milestone headline suffix. */
  queued: string;
  /** The header above the completed-steps list. */
  doneHeader: string;
  /** Elapsed-time wording: "<1 min", "N min", "H h M min" / Russian. */
  elapsed: {
    underMinute: string;
    minuteUnit: string;
    hourUnit: string;
    separator: string;
  };
  /** Generic verb labels per step family. */
  verbs: Record<DmProgressStepKind, string>;
  /** Document nouns per extension, keyed by the file extension. */
  documentNouns: Record<string, string>;
  /** The fallback noun when a read/edit target is unknown. */
  fileNoun: string;
  /** The slide-counting phrase builder ("слайды 4, 9" / "slides 4, 9"). */
  slides: {
    /** "слайд" / "slide" for one, "слайды" / "slides" for several. */
    singular: string;
    plural: string;
  };
  /** Event-derived step labels of the native run-log events. */
  events: {
    toolStarted: (message: string) => string;
    toolStartedFallback: string;
    toolCompleted: (message: string) => string;
    researchStarted: string;
    researchCompleted: string;
    delegationStarted: (message: string) => string;
    delegationStartedFallback: string;
    delegationCompleted: string;
    planUpdated: (message: string) => string;
    planUpdatedFallback: string;
    itemCompleted: (message: string) => string;
  };
  /** The clarifying-question tool step ("уточняю задачу" / "clarifying the task"). */
  clarify: string;
  /** The prefix of the unknown-tool fallback, with the name appended. */
  toolPrefix: (name: string) => string;
  /** "Говорящий N" is the voice-stt contract — NOT localized here. */
  speaker: (n: number) => string;
}

export const DM_PROGRESS_TEXTS: Record<DmProgressTextLocale, DmProgressTexts> = {
  ru: {
    working: "работаю",
    queued: "в очереди",
    doneHeader: "Сделано:",
    elapsed: {
      underMinute: "<1 мин",
      minuteUnit: "мин",
      hourUnit: "ч",
      separator: "·",
    },
    verbs: {
      read: "читаю",
      edit: "правлю",
      shell: "выполняю команду",
      check: "проверяю результат",
      search_files: "ищу в файлах",
      web_search: "ищу в интернете",
      web_page: "открываю страницу",
      image: "смотрю изображение",
      delegate: "запускаю помощника",
      think: "думаю",
      plan: "составляю план",
      memory: "вспоминаю контекст",
      answer: "пишу ответ",
      tool: "инструмент",
    },
    /** The ru clarify wording is the pre-catalog literal, byte-for-byte. */
    clarify: "уточняю задачу",
    documentNouns: {
      pptx: "презентацию",
      ppt: "презентацию",
      odp: "презентацию",
      key: "презентацию",
      docx: "документ",
      doc: "документ",
      odt: "документ",
      rtf: "документ",
      xlsx: "таблицу",
      xls: "таблицу",
      ods: "таблицу",
      csv: "таблицу",
      pdf: "PDF",
      png: "изображение",
      jpg: "изображение",
      jpeg: "изображение",
      webp: "изображение",
      gif: "изображение",
      svg: "изображение",
    },
    fileNoun: "файл",
    slides: { singular: "слайд", plural: "слайды" },
    events: {
      toolStarted: (message) => `инструмент: ${message}`,
      toolStartedFallback: "запускаю инструмент…",
      toolCompleted: (message) => `готово: ${message}`,
      researchStarted: "ищу информацию…",
      researchCompleted: "поиск завершён",
      delegationStarted: (message) => `помощник: ${message}`,
      delegationStartedFallback: "запускаю помощника…",
      delegationCompleted: "помощник завершил работу",
      planUpdated: (message) => `план: ${message}`,
      planUpdatedFallback: "обновляю план…",
      itemCompleted: (message) => `шаг готов: ${message}`,
    },
    toolPrefix: (name) => `инструмент: ${name}`,
    speaker: (n) => `Говорящий ${n}`,
  },
  en: {
    working: "working",
    queued: "queued",
    doneHeader: "Done:",
    elapsed: {
      underMinute: "<1 min",
      minuteUnit: "min",
      hourUnit: "h",
      separator: "·",
    },
    verbs: {
      read: "reading",
      edit: "editing",
      shell: "running a command",
      check: "checking the result",
      search_files: "searching files",
      web_search: "searching the web",
      web_page: "opening a page",
      image: "looking at an image",
      delegate: "spawning a helper",
      think: "thinking",
      plan: "planning",
      memory: "recalling context",
      answer: "writing the answer",
      tool: "tool",
    },
    clarify: "clarifying the task",
    documentNouns: {
      pptx: "presentation",
      ppt: "presentation",
      odp: "presentation",
      key: "presentation",
      docx: "document",
      doc: "document",
      odt: "document",
      rtf: "document",
      xlsx: "spreadsheet",
      xls: "spreadsheet",
      ods: "spreadsheet",
      csv: "spreadsheet",
      pdf: "PDF",
      png: "image",
      jpg: "image",
      jpeg: "image",
      webp: "image",
      gif: "image",
      svg: "image",
    },
    fileNoun: "file",
    slides: { singular: "slide", plural: "slides" },
    events: {
      toolStarted: (message) => `tool: ${message}`,
      toolStartedFallback: "starting a tool…",
      toolCompleted: (message) => `done: ${message}`,
      researchStarted: "researching…",
      researchCompleted: "research finished",
      delegationStarted: (message) => `helper: ${message}`,
      delegationStartedFallback: "spawning a helper…",
      delegationCompleted: "the helper finished",
      planUpdated: (message) => `plan: ${message}`,
      planUpdatedFallback: "updating the plan…",
      itemCompleted: (message) => `step done: ${message}`,
    },
    toolPrefix: (name) => `tool: ${name}`,
    speaker: (n) => `Speaker ${n}`,
  },
};

/**
 * The texts for a locale. The default is "ru" — the fork's historical
 * wording — so a caller that omits the locale (legacy seams, the ru tests)
 * gets byte-identical labels; the DM status publisher always passes the
 * instance locale explicitly.
 */
export function dmProgressTexts(locale: DmProgressTextLocale | null | undefined): DmProgressTexts {
  return DM_PROGRESS_TEXTS[locale ?? "ru"] ?? DM_PROGRESS_TEXTS.ru;
}
