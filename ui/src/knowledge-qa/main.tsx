// QA harness for the Knowledge screen (OPE-5957 / OPE-9222): the real screens,
// the real index.css (body is overflow:hidden, as in the app), the real UI2
// shell; the HTTP API is answered by Playwright (tests/knowledge-screen).
//   ?screen=ui2     -> Ui2Shell + Ui2Knowledge at /OPE/knowledge/...
//   ?screen=legacy  -> the current UI's Ui2KnowledgeCurrentUi at /OPE/wiki/..., in a
//                      frame that copies the scroll structure of Layout's <main>.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../index.css";
import { Ui2Shell } from "../ui2/shell/Ui2Shell";
import { Ui2I18nProvider } from "../ui2/i18n/Ui2I18n";
import { Ui2Knowledge } from "../ui2/screens/knowledge/Ui2Knowledge";
import { Ui2KnowledgeCurrentUi } from "../ui2/screens/knowledge/Ui2KnowledgeCurrentUi";
import { Ui2LanguageSettings } from "../ui2/screens/settings/language/Ui2LanguageSettings";

const params = new URLSearchParams(window.location.search);
const screenParam = params.get("screen");
const screen = screenParam === "legacy" ? "legacy" : screenParam === "language" ? "language" : "ui2";
const page = params.get("page") ?? "infra/long-page";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Ui2Language() {
  return (
    <Ui2I18nProvider>
      <Ui2Shell>
        <Routes>
          <Route path="/:companyPrefix/company/settings" element={<Ui2LanguageSettings />} />
          <Route path="/:companyPrefix/company/settings/language" element={<Ui2LanguageSettings />} />
        </Routes>
      </Ui2Shell>
    </Ui2I18nProvider>
  );
}

function Legacy() {
  return (
    <div className="flex h-dvh flex-col overflow-clip">
      <div className="flex min-h-0 flex-1 overflow-clip">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <main id="main-content" className="min-w-0 flex-1 overflow-auto p-4 md:p-6 [scrollbar-gutter:stable]">
              <Routes>
                <Route path="/:companyPrefix/wiki" element={<Ui2KnowledgeCurrentUi />} />
                <Route path="/:companyPrefix/wiki/:spaceKey/:slug" element={<Ui2KnowledgeCurrentUi />} />
              </Routes>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function Ui2() {
  return (
    <Ui2I18nProvider>
      <Ui2Shell>
        <Routes>
          <Route path="/:companyPrefix/knowledge" element={<Ui2Knowledge />} />
          <Route path="/:companyPrefix/knowledge/:spaceKey/:slug" element={<Ui2Knowledge />} />
        </Routes>
      </Ui2Shell>
    </Ui2I18nProvider>
  );
}

const [spaceKey, slug] = [page.slice(0, page.lastIndexOf("/")), page.slice(page.lastIndexOf("/") + 1)];
const start =
  screen === "legacy"
    ? `/OPE/wiki/${encodeURIComponent(spaceKey)}/${encodeURIComponent(slug)}`
    : screen === "language"
      ? `/OPE/company/settings/language`
      : `/OPE/knowledge/${encodeURIComponent(spaceKey)}/${encodeURIComponent(slug)}`;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[start]}>
        {screen === "legacy" ? <Legacy /> : screen === "language" ? <Ui2Language /> : <Ui2 />}
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
