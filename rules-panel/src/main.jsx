import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Download,
  FileCheck2,
  GitBranch,
  History,
  Layers3,
  ListFilter,
  LockKeyhole,
  MapPin,
  Pencil,
  Plane,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import "@fontsource-variable/inter";
import "./styles.css";
import * as policy from "./policy.mjs";
import { createService } from "./service.mjs";
import { filterRules, locationOptions, publishBlocker } from "./editor.mjs";
import { modeLabel } from "./display.mjs";
import { BusinessEditor, ReasonField } from "./BusinessEditor.jsx";
import { ImpactReview, OperationalStatus, SharedHistory } from "./WorkspaceViews.jsx";
import {
  createModel,
  buildRules,
  validateModel,
  updateRule,
  addRule,
  removeRule,
  setGroupEnabled,
  toDocuments,
  previewPolicy,
} from "./policy.mjs";
import {
  diffDocuments,
  readDraft,
  persistDraft,
  createProposal,
  downloadJson,
  withDraftLock,
  DRAFT_KEY,
} from "./draft.mjs";

const money = (value) =>
  new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(value);
const date = (value) =>
  value
    ? new Date(`${value}T12:00:00`).toLocaleDateString("pl-PL")
    : "Bezterminowo";
const snapshotTime = (value) =>
  new Date(value).toLocaleString("pl-PL", {
    timeZone: "Europe/Warsaw",
    timeZoneName: "short",
  });
const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(
    new Date(),
  );
const service = createService();
const categories = {
  location: "Minima lokalizacji",
  mandatory: "Minima obowiązkowe",
  protected: "Chronione daty",
  priority: "Cel Top 1",
  legacy: "Reguły uzupełniające",
};
const locationList = (model) => model.locations.locations ?? model.locations;
const knownGroups = (model) =>
  [
    ...new Set([...model.excel.apply_groups, ...model.excel.excluded_groups]),
  ].sort();
const nav = [
  ["rules", "Zasady cenowe", SlidersHorizontal],
  ["groups", "Klasy pojazdów", Layers3],
  ["preview", "Sprawdź reguły", ClipboardCheck],
  ["history", "Historia szkicu", History],
  ["sources", "Źródła i publikacja", GitBranch],
];
const titles = {
  rules: "Zasady cenowe",
  groups: "Klasy pojazdów",
  preview: "Sprawdź reguły",
  history: "Historia szkicu",
  sources: "Źródła i publikacja",
  review: "Podgląd zmian",
};
const period = (rule) =>
  rule.startDate || rule.endDate
    ? `${date(rule.startDate)} – ${date(rule.endDate)}`
    : "Bezterminowo";
const days = (rule) =>
  rule.minDays === rule.maxDays
    ? `${rule.minDays} ${rule.minDays === 1 ? "dzień" : "dni"}`
    : `${rule.minDays}–${rule.maxDays} dni`;
const groupText = (rule) =>
  !rule.groups?.length || rule.groups.includes("*")
    ? "Wszystkie klasy"
    : rule.groups.join(", ");
const scopeText = (rule, model) =>
  rule.kind === "airport"
    ? "Wszystkie lotniska"
    : rule.kind === "city"
      ? "Poza lotniskami"
      : !rule.zones?.length || rule.zones.includes("*")
        ? "Wszystkie lokalizacje"
        : rule.zones.map(zone => model ? locationOptions(model).find(item => item.value === zone)?.label ?? zone : zone).join(", ");
const iconFor = (rule) =>
  rule.category === "protected"
    ? ShieldCheck
    : rule.kind === "airport"
      ? Plane
      : rule.category === "priority"
        ? ArrowUpRight
        : rule.kind === "city"
          ? Building2
          : CalendarDays;
async function fetchSnapshot() {
  const response = await fetch("/policy-snapshot.json", { cache: "no-store" });
  if (!response.ok)
    throw new Error(
      "Nie można odczytać zasad. Sprawdź połączenie i dostęp do panelu, a następnie ponów próbę.",
    );
  const data = await response.json();
  if (data.schemaVersion !== 1 || !data.documents || !data.source?.policyHash)
    throw new Error("Nieobsługiwana wersja danych panelu.");
  return data;
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [workspaceData, setWorkspaceData] = useState(null);
  const remote = Boolean(workspaceData?.capabilities.sharedDraft);
  const [actionError, setActionError] = useState("");
  const [reason, setReason] = useState("");
  const actionRef = useRef(false);
  const pendingModelRef = useRef(null);
  const [clockTick, setClockTick] = useState(Date.now());
  const publicationBlocker = publishBlocker(workspaceData, clockTick);
  const hostedPreview = snapshot?.capabilities?.mode === "hosted-preview";
  const [model, setModel] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("rules");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [rulePeriod, setRulePeriod] = useState("current");
  const [editor, setEditor] = useState(null);
  const [stale, setStale] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const revisionRef = useRef(null);
  const blockedDraft = Boolean(stale || draftConflict);
  const mainRef = useRef(null);
  const original = useMemo(
    () => (snapshot ? createModel(snapshot.documents) : null),
    [snapshot],
  );
  const rules = useMemo(() => (model ? buildRules(model) : []), [model]);
  const originalRules = useMemo(
    () => (original ? buildRules(original) : []),
    [original],
  );
  const validation = useMemo(
    () =>
      model ? validateModel(model, original) : { errors: [], warnings: [] },
    [model, original],
  );
  const changes = useMemo(
    () =>
      model ? diffDocuments(toDocuments(original), toDocuments(model)) : [],
    [original, model],
  );
  const changedIds = useMemo(
    () =>
      new Set(
        rules
          .filter(
            (rule) =>
              JSON.stringify(rule) !==
              JSON.stringify(originalRules.find((item) => item.id === rule.id)),
          )
          .map((rule) => rule.id),
      ),
    [rules, originalRules],
  );
  const locations = model ? locationList(model) : [];

  function acceptWorkspace(data) {
    if (!data.snapshot?.documents || !data.capabilities)
      throw new Error("Nieprawidłowa odpowiedź workspace. Zachowano szkic tej karty.");
    const source = createModel(data.snapshot.documents);
    const sourceChanged = data.draft && ((data.draft.sourceRevision && data.draft.sourceRevision !== data.snapshot.source.revision) || (data.draft.sourceHash && data.draft.sourceHash !== data.snapshot.source.policyHash));
    const restored = sourceChanged ? source : data.draft?.model ?? source;
    const checked = validateModel(restored, source);
    if (checked.errors.length) throw new Error(checked.errors.map(item => item.message).join(" "));
    setWorkspaceData(data);
    setSnapshot(data.snapshot);
    setModel(restored);
    setHistory(data.history ?? []);
    setSaved(data.draft?.savedAt ?? null);
    revisionRef.current = data.draft?.revision ?? null;
    setDraftConflict(false);
    setStale(sourceChanged ? data.draft : null);
    pendingModelRef.current = null;
  }

  async function remoteAction(task) {
    if (actionRef.current) throw new Error("Poczekaj na zakończenie bieżącej operacji.");
    actionRef.current = true; setBusy(true); setActionError("");
    try { return await task(); }
    catch (error) {
      if (error.code === "DRAFT_CONFLICT") setDraftConflict(true);
      setActionError(error.message);
      throw error;
    } finally { actionRef.current = false; setBusy(false); }
  }

  async function previewDraft() {
    try {
      await remoteAction(async () => {
        const result = await service.preview(revisionRef.current);
        if (result.queued) {
          setWorkspaceData(current => ({ ...current, preview: { ...result, status: result.status ?? "queued" } }));
          setNotice("Przeliczenie zlecone. Odśwież wynik po zakończeniu przebiegu.");
        }
        else { acceptWorkspace(result); setNotice("Przeliczono wpływ szkicu. Nie opublikowano zmian."); }
      });
    } catch { /* Visible action error retains the current draft. */ }
  }

  async function publishDraft() {
    const preview = workspaceData?.preview;
    const blocker = publishBlocker(workspaceData);
    if (blocker) {
      setActionError(blocker);
      go("review"); return;
    }
    if (!window.confirm(`Opublikować szkic ${revisionRef.current} do zatwierdzonych plików konfiguracji w GitHub main? Nie oznacza to importu stawek do DiscoverCars.`)) return;
    try {
      await remoteAction(async () => {
        const published = await service.publish(revisionRef.current, preview.revision);
        setNotice(`Opublikowano konfigurację: ${published.revision}. Import stawek nie został potwierdzony.`);
        acceptWorkspace(await service.workspace());
      });
    } catch { /* The API error is displayed without retrying publication. */ }
  }

  async function rollback(revision) {
    if (!window.confirm(`Przygotować szkic z wersji ${revision}? Bieżący szkic współdzielony zostanie zastąpiony; GitHub main pozostanie bez zmian.`)) return;
    try {
      await remoteAction(async () => {
        acceptWorkspace(await service.rollback(revision, revisionRef.current));
        setNotice("Przygotowano szkic z wybranej wersji. Nie opublikowano zmian.");
      });
    } catch { /* The API error is visible above the history. */ }
  }

  async function load() {
    setLoadError("");
    setActionError("");
    try {
      const workspace = await service.workspace();
      if (workspace.capabilities.sharedDraft) { acceptWorkspace(workspace); return; }
      const data = workspace.snapshot;
      const initial = createModel(data.documents);
      const sourceValidation = validateModel(initial, initial);
      if (sourceValidation.errors.length) throw new Error(`Źródłowe zasady wymagają korekty: ${sourceValidation.errors.map(item=>item.message).join(' ')}`);
      const local = readDraft(localStorage, data.source.policyHash);
      revisionRef.current = local.draft?.revision ?? local.revision ?? null;
      setDraftConflict(false);
      setStale(null);
      setHistory([]);
      setSaved(null);
      let restored = initial;
      if (local.state === "restored") {
        const checked = validateModel(local.draft.model, initial);
        if (checked.errors.length)
          setNotice(
            "Zapisany szkic zawiera błędy. Wczytano zasady źródłowe; szkic pozostał w pamięci przeglądarki.",
          );
        else {
          restored = local.draft.model;
          setHistory(local.draft.history);
          setSaved(local.draft.savedAt);
        }
      }
      if (local.state === "stale") {
        setStale(local.draft);
        setNotice(
          "Źródło zasad zmieniło się od zapisania szkicu. Poprzedni szkic nie został zastosowany.",
        );
      }
      if (local.state === "invalid")
        setNotice(
          "Nie udało się odczytać zapisanego szkicu. Wczytano zasady źródłowe.",
        );
      setSnapshot(data);
      setWorkspaceData(workspace);
      setModel(restored);
    } catch (error) {
      setLoadError(error.message);
      setNotice(error.message);
      setActionError(error.message);
    }
  }
  function refreshWorkspace() {
    if (pendingModelRef.current && !window.confirm("Wczytać zapis serwera? Niezapisane zmiany tej karty zostaną zastąpione. Możesz najpierw pobrać szkic tej karty.")) return;
    load();
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClockTick(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (remote) return;
    const changed = (event) => {
      if (event.key !== DRAFT_KEY && event.key !== null) return;
      let revision = null;
      try {
        revision = JSON.parse(event.newValue)?.revision ?? null;
      } catch {
        /* Invalid storage also requires attention. */
      }
      if (revision !== revisionRef.current) setDraftConflict(true);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [remote]);

  function go(next) {
    setView(next);
    setTimeout(() => {
      mainRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }, 0);
  }
  async function commit(next, label, changeReason = reason) {
    if (blockedDraft)
      throw new Error("Rozpocznij nowy szkic na aktualnej wersji zasad.");
    const expectedRevision = revisionRef.current;
    const checked = validateModel(next, original);
    if (checked.errors.length)
      throw new Error(checked.errors.map((item) => item.message).join(" "));
    const delta = diffDocuments(toDocuments(model), toDocuments(next));
    if (!delta.length) return;
    if (remote) {
      pendingModelRef.current = next;
      await remoteAction(async () => {
        const result = await service.save({ expectedRevision, sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash, model: next, reason: changeReason });
        if (!result.draft?.revision) throw new Error("Serwer nie potwierdził zapisu szkicu. Zachowano bieżącą wersję.");
        acceptWorkspace(result);
        setReason("");
        setNotice("Zapisano szkic współdzielony. Nie opublikowano konfiguracji ani stawek.");
      });
      return;
    }
    const at = new Date().toISOString();
    const nextHistory = [
      ...history,
      { id: crypto.randomUUID(), at, label, changes: delta },
    ].slice(-50);
    try {
      const record = await withDraftLock(() =>
        persistDraft(localStorage, {
          sourceHash: snapshot.source.policyHash,
          model: next,
          history: nextHistory,
          expectedRevision,
        }),
      );
      revisionRef.current = record.revision;
      setSaved(at);
      setNotice(
        "Zapisano szkic lokalny. Działające zasady pozostają bez zmian.",
      );
    } catch (error) {
      if (error.code === "DRAFT_CONFLICT") {
        setDraftConflict(true);
        throw error;
      }
      setNotice(
        "Nie udało się zapisać w przeglądarce. Szkic jest tylko w pamięci tej karty; pobierz propozycję przed zamknięciem.",
      );
      setSaved(null);
    }
    setModel(next);
    setHistory(nextHistory);
  }
  async function reset() {
    if (remote) {
      if (!window.confirm("Rozpocząć edycję od aktualnego źródła? Poprzedni szkic pozostanie w historii; nowe zmiany wymagają zapisu z powodem.")) return;
      setModel(original); setStale(null); pendingModelRef.current = null;
      setNotice("Rozpoczęto edycję od aktualnego źródła. Szkic współdzielony zostanie zastąpiony dopiero po zapisaniu zmian.");
      return;
    }
    if (
      !window.confirm(
        "Rozpocząć szkic od aktualnych zasad źródłowych? Lokalna historia zmian zostanie wyczyszczona.",
      )
    )
      return;
    const expectedRevision = revisionRef.current;
    try {
      const record = await withDraftLock(() =>
        persistDraft(localStorage, {
          sourceHash: snapshot.source.policyHash,
          model: original,
          history: [],
          expectedRevision,
        }),
      );
      revisionRef.current = record.revision;
      setStale(null);
      setDraftConflict(false);
      setModel(original);
      setHistory([]);
      setSaved(null);
      setNotice("Wczytano zasady źródłowe. Produkcja nie została zmieniona.");
    } catch (error) {
      if (error.code === "DRAFT_CONFLICT") setDraftConflict(true);
      setNotice(error.message);
    }
  }
  async function exportProposal() {
    setBusy(true);
    const expectedRevision = revisionRef.current;
    try {
      const fresh = remote ? (await service.workspace()).snapshot : await fetchSnapshot();
      const currentDraft = readDraft(localStorage, snapshot.source.policyHash);
      if (
        blockedDraft ||
        (!remote && (currentDraft.draft?.revision ?? currentDraft.revision ?? null) !==
          expectedRevision)
      ) {
        setDraftConflict(true);
        throw new Error(
          "Szkic zmienił się w innej karcie. Wczytaj aktualną wersję przed eksportem.",
        );
      }
      const proposal = createProposal({
        source: snapshot.source,
        currentHash: fresh.source.policyHash,
        documents: toDocuments(model),
        originalDocuments: toDocuments(original),
        errors: validation.errors,
      });
      downloadJson(proposal, `discovercars-zasady-szkic-${today()}.json`);
      setNotice(
        "Pobrano propozycję. Nie opublikowano zmian w GitHub ani w DiscoverCars.",
      );
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }
  if (!model)
    return (
      <div className="boot">
        <SlidersHorizontal size={28} />
        <h1>Panel zasad DiscoverCars</h1>
        {loadError ? (
          <>
            <p role="alert">{loadError}</p>
            <button className="button primary" onClick={load}>
              Ponów odczyt
            </button>
          </>
        ) : (
          <p role="status">Wczytywanie migawki zasad…</p>
        )}
      </div>
    );

  const filtered = filterRules(rules, { today: today(), period: rulePeriod }).filter(
    (rule) =>
      (category === "all" || rule.category === category) &&
      `${rule.title} ${groupText(rule)} ${scopeText(rule, model)} ${period(rule)}`
        .toLocaleLowerCase("pl")
        .includes(search.toLocaleLowerCase("pl")),
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Przejdź do treści
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("rules");
          }}
          aria-label="MM Cars Rental, zasady DiscoverCars"
        >
          <span className="brand-symbol">
            <SlidersHorizontal size={23} />
          </span>
          <span>
            <strong>MM Cars Rental</strong>
            <span>DiscoverCars</span>
          </span>
        </a>
        <nav aria-label="Panel DiscoverCars">
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              aria-current={view === id ? "page" : undefined}
              aria-label={label}
              onClick={() => go(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "rules" && (
                <span className="nav-count">{rules.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-dot" />
          <span>{remote ? "Szkic współdzielony" : hostedPreview ? "Podgląd online" : "Wersja lokalna"}</span>
          <button
            className="icon-button"
            title="Źródła i stan publikacji"
            aria-label="Źródła i stan publikacji"
            onClick={() => go("sources")}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            DiscoverCars <ChevronRight size={14} />
            <span>Kontrola zasad</span>
          </div>
          <div className="topbar-status">
            <GitBranch size={15} />
            <span>{snapshot.source.revision.slice(0, 7)}</span>
            <span className="divider" />
            <span className="local-label">{remote ? "Szkic współdzielony" : "Szkic w tej przeglądarce"}</span>
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1>{titles[view]}</h1>
              <p>
                {view === "rules"
                  ? "Minima, okresy ochronne i cele cenowe."
                  : view === "groups"
                    ? "Dopuszczenie klas do rekomendacji rynkowych."
                    : view === "preview"
                      ? "Obowiązujące minima dla konkretnego najmu."
                      : view === "review"
                        ? "Porównanie szkicu z zasadami źródłowymi."
                        : view === "history"
                          ? remote ? "Zmiany w szkicu współdzielonym." : "Zmiany zapisane w tej przeglądarce."
                          : "Konfiguracja projektu i stan połączeń."}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button" onClick={() => go("review")}>
                <FileCheck2 size={17} />
                Podgląd zmian
                {changes.length > 0 && (
                  <span className="button-count">{changes.length}</span>
                )}
              </button>
              <span className="disabled-wrapper" tabIndex={publicationBlocker ? 0 : undefined} title={publicationBlocker || "Publikacja konfiguracji do GitHub main, bez importu stawek."}>
                <button className="button primary" disabled={Boolean(publicationBlocker) || busy || blockedDraft || validation.errors.length > 0} onClick={publishDraft}>
                  <LockKeyhole size={16} />
                  Opublikuj
                </button>
              </span>
            </div>
          </div>
          <div className="info-line">
            <History size={17} />
            <span>
              <strong>{modeLabel(snapshot.capabilities?.mode)}</strong>
              {hostedPreview ? " · Stan zasad na " : " · Odczyt konfiguracji: "}
              <time dateTime={snapshot.source.loadedAt}>
                {snapshotTime(snapshot.source.loadedAt)}
              </time>
            </span>
          </div>
          <div className="status-strip">
            <span>
              <Check size={15} />
              {locations.length} punktów ·{" "}
              {locations.flatMap((item) => item.zones).length} kodów Excel
            </span>
            <span>{knownGroups(model).length} klas</span>
            <span>PLN brutto / dobę</span>
            <span className="status-strip-end">
              {changes.length
                ? `Zmienione pola: ${changes.length}`
                : "Brak zmian w szkicu"}
            </span>
          </div>
          {actionError && <div className="alert error" role="alert"><TriangleAlert size={18} /><div><p>{actionError}</p>{pendingModelRef.current && !draftConflict && <button className="text-button" onClick={() => downloadJson({ sourceHash: snapshot.source.policyHash, model: pendingModelRef.current }, "discovercars-niezapisany-szkic.json")}>Pobierz niezapisane zmiany</button>}{loadError && <button className="text-button" disabled={busy} onClick={refreshWorkspace}>Ponów odczyt</button>}</div></div>}
          {notice && (
            <div className="notice" role="status">
              <CircleHelp size={17} />
              <span>{notice}</span>
              <button
                className="icon-button"
                onClick={() => setNotice("")}
                aria-label="Zamknij komunikat"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {stale && (
            <div className="alert">
              <TriangleAlert size={20} />
              <div>
                <strong>Poprzedni szkic ma inną wersję źródła</strong>
                <div className="inline-actions">
                  <button
                    className="text-button"
                    onClick={() =>
                      downloadJson(stale, "discovercars-poprzedni-szkic.json")
                    }
                  >
                    Pobierz poprzedni szkic
                  </button>
                  <button className="text-button" onClick={reset}>
                    Rozpocznij aktualny szkic
                  </button>
                </div>
              </div>
            </div>
          )}
          {draftConflict && (
            <div className="alert" role="alert">
              <TriangleAlert size={20} />
              <div>
                <strong>{remote ? "Szkic współdzielony ma nowszą wersję" : "Szkic zmieniono w innej karcie"}</strong>
                <p>Ta karta nie nadpisze nowszych zmian.</p>
                <div className="inline-actions">
                  <button
                    className="text-button"
                    onClick={() =>
                      downloadJson(
                        {
                          schemaVersion: 1,
                          sourceHash: snapshot.source.policyHash,
                          model: pendingModelRef.current ?? model,
                          history,
                        },
                        "discovercars-szkic-tej-karty.json",
                      )
                    }
                  >
                    Pobierz szkic tej karty
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Wczytać nowszy zapis? Otwarty szkic tej karty zostanie zastąpiony.",
                        )
                      ) {
                        setEditor(null);
                        load();
                      }
                    }}
                  >
                    Wczytaj nowszy szkic
                  </button>
                </div>
              </div>
            </div>
          )}
          {validation.errors.length > 0 && (
            <div className="alert error" role="alert">
              <TriangleAlert size={20} />
              <div>
                {validation.errors.map((item) => (
                  <p key={item.path + item.message}>{item.message}</p>
                ))}
              </div>
            </div>
          )}

          {view === "rules" && (
            <>
              <div className="section-toolbar">
                <div className="search-control">
                  <Search size={18} />
                  <input
                    aria-label="Szukaj zasad"
                    placeholder="Szukaj reguły, kodu lub klasy…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      className="icon-button"
                      aria-label="Wyczyść wyszukiwanie"
                      onClick={() => setSearch("")}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                <div className="filter-control">
                  <ListFilter size={17} />
                  <select
                    aria-label="Rodzaj reguły"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    <option value="all">Wszystkie reguły</option>
                    {Object.entries(categories).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="filter-control"><CalendarDays size={17} /><select aria-label="Okres reguł" value={rulePeriod} onChange={event => setRulePeriod(event.target.value)}><option value="current">Bieżące i nadchodzące</option><option value="expired">Zakończone</option><option value="all">Wszystkie okresy</option></select></div>
                <button
                  className="button primary"
                  disabled={blockedDraft || busy}
                  onClick={() => setEditor({ isNew: true })}
                >
                  <Plus size={17} />
                  Dodaj regułę
                </button>
              </div>
              <div className="table-caption">
                <span>{filtered.length} reguł</span>
                <span>
                  <span className="legend-dot" />
                  Zmiana w szkicu
                </span>
              </div>
              <div className="rule-table">
                <div className="table-head">
                  <span>Reguła i zakres</span>
                  <span>Minimum reguły</span>
                  <span>Najem</span>
                  <span>Daty startu</span>
                  <span className="sr-only">Działania</span>
                </div>
                {filtered.map((rule) => {
                  const Icon = iconFor(rule);
                  const changed = changedIds.has(rule.id);
                  const expired = rule.endDate && rule.endDate < today();
                  return (
                    <article
                      className={`rule-row ${changed ? "changed" : ""}`}
                      key={rule.id}
                      data-rule-id={rule.id}
                    >
                      <div className="rule-primary">
                        <span className={`rule-icon ${rule.category}`}>
                          <Icon size={19} />
                        </span>
                        <div>
                          <div className="rule-title">
                            {rule.title}
                            {changed && (
                              <span className="draft-tag">Szkic</span>
                            )}
                          </div>
                          <div className="rule-scope">{rule.zones?.length > 3 && !rule.zones.includes("*") ? <details className="scope-details"><summary>{rule.zones.length} lokalizacji</summary>{scopeText(rule, model)}</details> : scopeText(rule, model)}</div>
                          <div className="rule-groups">{groupText(rule)}</div>
                          {rule.overrideProtected && (
                            <span className="exception-label">
                              Wyjątek od ochrony dat
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="rate-cell" data-label="Minimum">
                        {rule.amount === null || rule.amount === undefined ? (
                          <span className="muted">Bez zmiany cen</span>
                        ) : (
                          <>
                            <strong>{money(rule.amount)}</strong>
                            <span> PLN / dobę</span>
                            {rule.category === "priority" && (
                              <small className="subordinate-floor">
                                Nadrzędne:{" "}
                                {money(
                                  model.pricing.pricing.locationTypeFloorsPlnDay
                                    .minimumRatesByKind.airport,
                                )}
                                /
                                {money(
                                  model.pricing.pricing.locationTypeFloorsPlnDay
                                    .minimumRatesByKind.city,
                                )}{" "}
                                PLN
                              </small>
                            )}
                          </>
                        )}
                      </div>
                      <div className="duration-cell" data-label="Najem">
                        {rule.minDays ? days(rule) : "Wszystkie długości"}
                      </div>
                      <div className="dates-cell" data-label="Daty startu">
                        {period(rule)}
                        <span
                          className={`status-label ${expired ? "muted" : ""}`}
                        >
                          {expired
                            ? "Okres zakończony"
                            : rule.startDate && rule.startDate > today()
                              ? "Nadchodzący okres"
                              : rule.category === "legacy"
                                ? "Reguła uzupełniająca"
                                : rule.category === "priority"
                                  ? "Podlega nadrzędnym minimom"
                                  : "Obowiązuje"}
                        </span>
                      </div>
                      <div className="row-action">
                        <button
                          className="icon-button"
                          disabled={!rule.editable || blockedDraft || busy}
                          aria-label={`Edytuj: ${rule.title}`}
                          title={
                            rule.editable
                              ? "Edytuj regułę"
                              : "Reguła tylko do odczytu"
                          }
                          onClick={() => setEditor({ rule })}
                        >
                          {rule.editable ? (
                            <Pencil size={17} />
                          ) : (
                            <LockKeyhole size={16} />
                          )}
                        </button>
                      </div>
                    </article>
                  );
                })}
                {!filtered.length && (
                  <Empty
                    icon={Search}
                    title="Brak pasujących reguł"
                    action={
                      <button
                        className="text-button"
                        onClick={() => {
                          setSearch("");
                          setCategory("all");
                          setRulePeriod("current");
                        }}
                      >
                        Wyczyść filtry
                      </button>
                    }
                  />
                )}
              </div>
              <div className="footnote">
                <ShieldCheck size={17} />
                <span>
                  Chronione terminy pozostają bez zmian, z wyjątkiem minimów
                  obowiązkowych oznaczonych jako nadrzędne.
                </span>
                <button className="text-button" onClick={() => go("preview")}>
                  Sprawdź konkretny najem <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}
          {view === "groups" && (
            <>
            {remote && <div className="shared-reason"><ReasonField value={reason} onChange={setReason} /></div>}
            <Groups
              model={model}
              stale={blockedDraft || busy}
              onToggle={async (group, enabled) => {
                try {
                  await commit(
                    setGroupEnabled(model, group, enabled),
                    `${group}: ${enabled ? "dopuszczenie" : "wyłączenie"} rekomendacji`,
                  );
                } catch (error) {
                  setNotice(error.message);
                  setActionError(error.message);
                }
              }}
            />
            </>
          )}
          {view === "preview" && <Preview model={model} rules={rules} />}
          {view === "review" && (
            <>
            {remote && <ImpactReview workspace={workspaceData} model={model} busy={busy} blocked={blockedDraft} publicationBlocker={publicationBlocker} onPreview={previewDraft} onRefresh={refreshWorkspace} />}
            <Review
              {...{
                model,
                original,
                rules,
                originalRules,
                changes,
                validation,
                stale: blockedDraft,
                busy,
                exportProposal,
                reset,
                remote,
              }}
            />
            </>
          )}
          {view === "history" && (
            remote ? <SharedHistory workspace={workspaceData} busy={busy} blocked={blockedDraft} onRollback={rollback} /> :
            <section className="history-view">
              {!history.length ? (
                <Empty
                  icon={History}
                  title="Brak zapisanych zmian"
                  action={
                    <button className="text-button" onClick={() => go("rules")}>
                      Przejdź do zasad <ArrowRight size={15} />
                    </button>
                  }
                />
              ) : (
                <>
                  <div className="section-title">
                    <h2>Ostatnie zmiany</h2>
                    <span>Do 50 wpisów lokalnych</span>
                  </div>
                  <ol className="history-list">
                    {[...history].reverse().map((item) => (
                      <li key={item.id}>
                        <span className="history-icon">
                          <Pencil size={16} />
                        </span>
                        <div>
                          <strong>{item.label}</strong>
                          <span>
                            {new Date(item.at).toLocaleString("pl-PL")} ·{" "}
                            {item.changes.length} zmienionych pól
                          </span>
                        </div>
                        <span className="badge amber">Szkic</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          )}
          {view === "sources" && <><OperationalStatus workspace={workspaceData} snapshot={snapshot} /><Sources snapshot={snapshot} model={model} remote={remote} capabilities={workspaceData?.capabilities} /></>}
          <footer className="page-footer">
            <span>
              <LockKeyhole size={14} />
              {remote ? `Szkic współdzielony · ${workspaceData.capabilities.publish ? "Publikacja konfiguracji dostępna" : "Publikacja nieaktywna"}` : "Szkic tylko w tej przeglądarce · Publikacja niepodłączona"}
            </span>
            <span>
              {saved
                ? `Zapis szkicu: ${new Date(saved).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}`
                : `${hostedPreview ? "Stan zasad na" : "Odczyt"}: ${snapshotTime(snapshot.source.loadedAt)}`}
            </span>
          </footer>
        </main>
      </div>
      {editor?.isNew && <BusinessEditor model={model} remote={remote} supported={typeof policy.addFloorMatrix === "function"} onClose={() => setEditor(null)} onSave={async (fields, changeReason) => {
        const next = fields.category === "protected" ? addRule(model, fields) : typeof policy.addFloorMatrix === "function" ? policy.addFloorMatrix(model, fields) : null;
        if (!next) throw new Error("Zapis zakresów oczekuje na integrację silnika reguł.");
        await commit(next, fields.category === "protected" ? "Dodano okres ochronny" : "Dodano minimum dla lokalizacji i klas", changeReason);
        setEditor(null);
      }} />}
      {editor && !editor.isNew && (
        <RuleEditor
          key={editor.rule?.id ?? "new"}
          {...editor}
          model={model}
          remote={remote}
          onClose={() => setEditor(null)}
          onSave={async (patch, changeReason) => {
            const next = editor.isNew
              ? addRule(model, patch)
              : updateRule(model, editor.rule.id, patch);
            await commit(
              next,
              editor.isNew
                ? "Dodano regułę"
                : `Zmieniono: ${editor.rule.title}`,
              changeReason,
            );
            setEditor(null);
          }}
          onDelete={async (changeReason) => {
            if (
              window.confirm(
                "Usunąć tę regułę ze szkicu? Działające zasady pozostaną bez zmian.",
              )
            ) {
              await commit(
                removeRule(model, editor.rule.id),
                `Usunięto: ${editor.rule.title}`,
                changeReason,
              );
              setEditor(null);
            }
          }}
        />
      )}
    </div>
  );
}

function Empty({ icon: Icon, title, action }) {
  return (
    <div className="empty-state">
      <Icon size={30} />
      <h2>{title}</h2>
      {action}
    </div>
  );
}
function Groups({ model, onToggle, stale }) {
  const parity = model.excel.group_price_parity;
  return (
    <section>
      <div className="info-line">
        <ShieldCheck size={18} />
        <span>
          Wyłączenie rekomendacji rynkowych nie wyłącza obowiązkowych minimów.
          FVMD nie występuje w SZLO.
        </span>
      </div>
      <div className="group-table">
        <div className="group-head">
          <span>Klasa</span>
          <span>Powiązanie cenowe</span>
          <span>Rekomendacje rynkowe</span>
        </div>
        {knownGroups(model).map((group) => {
          const enabled = model.excel.apply_groups.includes(group);
          const premium = parity.premium_adjustments_pln_day?.[group];
          return (
            <div className="group-row" key={group}>
              <strong>{group}</strong>
              <span>
                {parity.base_groups.includes(group)
                  ? "Wspólna cena grupy bazowej"
                  : premium !== undefined
                    ? `Grupa bazowa + ${money(premium)} PLN / dobę`
                    : "Stawka z pliku bazowego"}
              </span>
              <label className="switch-label">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Rekomendacje dla ${group}`}
                  checked={enabled}
                  disabled={Boolean(stale)}
                  onChange={(e) => onToggle(group, e.target.checked)}
                />
                <span className="switch-track" />
                <span>{enabled ? "Włączone" : "Wyłączone"}</span>
              </label>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Preview({ model, rules }) {
  const zones = locationOptions(model).map(item => ({ zone: item.value, label: item.label }));
  const [query, setQuery] = useState({
    zone: "WR1",
    group: "CDMV",
    pickupDate: today(),
    duration: 3,
    baselineRate: null,
  });
  const result = useMemo(() => previewPolicy(model, query), [model, query]);
  const queryValid =
    Boolean(query.pickupDate) &&
    (query.baselineRate === null ||
      (Number.isFinite(query.baselineRate) && query.baselineRate >= 0));
  const set = (key, value) => setQuery({ ...query, [key]: value });
  return (
    <section className="preview-layout">
      <div className="query-form">
        <h2>Parametry najmu</h2>
        <label>
          Lokalizacja
          <select
            aria-label="Lokalizacja"
            value={query.zone}
            onChange={(e) => set("zone", e.target.value)}
          >
            {zones.map((item) => (
              <option key={item.zone} value={item.zone}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Klasa
            <select
              aria-label="Klasa"
              value={query.group}
              onChange={(e) => set("group", e.target.value)}
            >
              {knownGroups(model).map((group) => (
                <option key={group}>{group}</option>
              ))}
            </select>
          </label>
          <label>
            Długość najmu
            <select
              aria-label="Długość najmu"
              value={query.duration}
              onChange={(e) => set("duration", Number(e.target.value))}
            >
              {Array.from({ length: 35 }, (_, index) => index + 1).map(
                (value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "dzień" : "dni"}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <label>
          Data startu
          <input
            required
            type="date"
            value={query.pickupDate}
            onChange={(e) => set("pickupDate", e.target.value)}
          />
        </label>
        <label>
          Stawka z bazy (PLN / dobę)
          <input
            min="0"
            max="100000"
            type="number"
            step="0.01"
            value={query.baselineRate ?? ""}
            placeholder="Nie podano"
            onChange={(e) =>
              set(
                "baselineRate",
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
          />
        </label>
      </div>
      <div className="preview-result" aria-live="polite">
        <div className="section-title">
          <h2>Wynik sprawdzenia zasad</h2>
          <span className="badge">
            {query.zone} · {query.group}
          </span>
        </div>
        <div className="result-primary">
          <div>
            <span>Obowiązujące minimum</span>
            <strong>
              {!queryValid
                ? "Nieprawidłowe parametry"
                : result.omitted
                  ? "Brak pozycji"
                  : result.floor === null || result.floor === undefined
                    ? "Brak minimum"
                    : `${money(result.floor)} PLN`}
              <small>
                {queryValid && !result.omitted && result.floor !== null
                  ? " / dobę"
                  : ""}
              </small>
            </strong>
          </div>
          <ShieldCheck size={32} />
        </div>
        <dl className="result-facts">
          <div>
            <dt>Rekomendacje rynkowe</dt>
            <dd>
              {result.marketAllowed ? (
                <span className="positive">Dozwolone</span>
              ) : (
                <span>Wyłączone</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Chroniona data</dt>
            <dd>{result.protected ? "Tak" : "Nie"}</dd>
          </div>
          <div>
            <dt>Stawka po samych obowiązkowych minimach</dt>
            <dd>
              {result.minimumAfterBaseline === null ||
              result.minimumAfterBaseline === undefined
                ? query.baselineRate === null
                  ? "Brak stawki bazowej"
                  : "Nie dotyczy"
                : `${money(result.minimumAfterBaseline)} PLN / dobę`}
            </dd>
          </div>
        </dl>
        <h3>Rozstrzygnięcie</h3>
        <ul className="reason-list">
          {result.reasons.map((reason, index) => (
            <li key={index}>
              <Check size={16} />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
        <div className="preview-disclaimer">
          <CircleHelp size={17} />
          <span>
            To sprawdzenie reguł, nie rekomendacja rynkowa. Ostateczna cena
            wymaga danych konkurencji, zatwierdzonego narzutu i kontroli jakości
            w scraperze.
          </span>
        </div>
        {result.limitations
          ?.filter((text) => /rozbieżność|discrepancy/i.test(text))
          .map((text, index) => (
            <div key={index} className="alert preview-warning">
              <TriangleAlert size={18} />
              <span>{text}</span>
            </div>
          ))}
        {result.matchedRuleIds?.length > 0 && (
          <div className="matched-rules">
            <h3>Dopasowane reguły</h3>
            {result.matchedRuleIds.map((id) => (
              <span className="badge" key={id}>
                {rules.find((rule) => rule.id === id)?.title ?? id}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Review({
  model,
  original,
  rules,
  originalRules,
  changes,
  validation,
  stale,
  busy,
  exportProposal,
  reset,
  remote,
}) {
  const differences = [
    ...new Set([
      ...rules.map((rule) => rule.id),
      ...originalRules.map((rule) => rule.id),
    ]),
  ]
    .map((id) => ({
      before: originalRules.find((rule) => rule.id === id),
      after: rules.find((rule) => rule.id === id),
    }))
    .filter(
      ({ before, after }) => JSON.stringify(before) !== JSON.stringify(after),
    );
  const groupDiff = knownGroups(original).filter(
    (group) =>
      original.excel.apply_groups.includes(group) !==
      model.excel.apply_groups.includes(group),
  );
  return (
    <section>
      {changes.length === 0 ? (
        <Empty icon={CheckCheck} title="Nie ma jeszcze zmian do sprawdzenia" />
      ) : (
        <>
          <div className="review-banner">
            <CheckCheck size={22} />
            <div>
              <strong>
                {validation.errors.length
                  ? "Szkic wymaga poprawek"
                  : "Szkic przeszedł walidację pól"}
              </strong>
              <span>
                {changes.length} zmienionych pól · {differences.length} reguł ·{" "}
                {groupDiff.length} klas
              </span>
            </div>
            <span className="badge amber">Nieopublikowany</span>
          </div>
          <div className="diff-table">
            <div className="diff-head">
              <span>Reguła</span>
              <span>Obecne zasady</span>
              <span>Szkic</span>
            </div>
            {differences.map(({ before, after }) => (
              <div className="diff-row" key={(after ?? before).id}>
                <strong>{(after ?? before).title}</strong>
                <RuleSummary rule={before} model={model} />
                <RuleSummary rule={after} model={model} />
              </div>
            ))}
            {groupDiff.map((group) => (
              <div className="diff-row" key={group}>
                <strong>{group}</strong>
                <span>
                  {original.excel.apply_groups.includes(group)
                    ? "Rekomendacje włączone"
                    : "Rekomendacje wyłączone"}
                </span>
                <span>
                  {model.excel.apply_groups.includes(group)
                    ? "Rekomendacje włączone"
                    : "Rekomendacje wyłączone"}
                </span>
              </div>
            ))}
          </div>
          {validation.warnings.length > 0 && (
            <div className="warning-list">
              <h3>Uwagi do szkicu</h3>
              {validation.warnings.map((item, index) => (
                <p key={index}>
                  <TriangleAlert size={16} />
                  {item.message}
                </p>
              ))}
            </div>
          )}
          <div className="review-actions">
            <button
              className="button primary"
              disabled={busy || Boolean(stale) || validation.errors.length > 0}
              onClick={exportProposal}
            >
              <Download size={17} />
              {busy ? "Sprawdzanie źródła…" : "Pobierz propozycję JSON"}
            </button>
            {!remote && <button className="button" onClick={reset}>
              <RotateCcw size={16} />
              Przywróć zasady źródłowe
            </button>}
          </div>
          <div className="info-line">
            <LockKeyhole size={18} />
            <span>
              Plik jest propozycją do wdrożenia, nie plikiem importowym
              DiscoverCars. Zapis szkicu nie zmienia stawek ani harmonogramów.
            </span>
          </div>
        </>
      )}
    </section>
  );
}
function RuleSummary({ rule, model }) {
  return !rule ? (
    <span className="muted">Brak reguły</span>
  ) : (
    <div className="rule-summary">
      <strong>
        {rule.amount === null || rule.amount === undefined
          ? "Ochrona cen"
          : `${money(rule.amount)} PLN / dobę`}
      </strong>
      <span>
        {days(rule)} · {scopeText(rule, model)}
      </span>
      <span>{groupText(rule)}</span>
      <span>{period(rule)}</span>
      {rule.overrideProtected && <span>Wyjątek od ochrony dat</span>}
    </div>
  );
}

function Sources({ snapshot, model, remote, capabilities }) {
  const hostedPreview = snapshot.capabilities?.mode === "hosted-preview";
  return (
    <section>
      <div className="section-title">
        <h2>Połączenia</h2>
        <span className="badge amber">
          {remote ? "Szkic współdzielony" : hostedPreview ? "Podgląd online" : "Tryb lokalny"}
        </span>
      </div>
      <div className="connection-row">
        <GitBranch size={22} />
        <div>
          <strong>prejsik/discovercars-tool</strong>
          <span>
            {snapshot.capabilities?.mode === "github" ? "Źródło GitHub" : hostedPreview ? "Migawka konfiguracji" : "Lokalny odczyt konfiguracji"}
            {" · wersja "}
            {snapshot.source.revision.slice(0, 7)}
          </span>
        </div>
        <span className="badge positive">Odczyt dostępny</span>
      </div>
      <div className="connection-row">
        <LockKeyhole size={22} />
        <div>
          <strong>Publikacja do GitHub</strong>
          <span>{capabilities?.reason || "Wymaga autoryzowanej integracji GitHub App."}</span>
        </div>
        <span className="badge">{capabilities?.publish ? "Dostępna" : remote ? "Nieaktywna" : "Niepodłączona"}</span>
      </div>
      <div className="connection-row">
        <ShieldCheck size={22} />
        <div>
          <strong>Dostęp do podglądu</strong>
          <span>
            {snapshot.capabilities?.authentication === "cloudflare-access"
              ? "Logowanie Cloudflare Access."
              : "Logowanie Cloudflare Access nie jest podłączone lokalnie."}
          </span>
        </div>
        <span className="badge">
          {snapshot.capabilities?.authentication === "cloudflare-access"
            ? "Cloudflare Access"
            : "Niepodłączone"}
        </span>
      </div>
      <div className="section-title spaced">
        <h2>Źródła zasad</h2>
      </div>
      <dl className="source-list">
        <div>
          <dt>{hostedPreview ? "Stan zasad na" : "Odczyt konfiguracji"}</dt>
          <dd>
            <time dateTime={snapshot.source.loadedAt}>
              {snapshotTime(snapshot.source.loadedAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Plik bazowy</dt>
          <dd>
            {snapshot.baseline.filename}
            <small>Zatwierdzony {date(snapshot.baseline.approvedAt)}</small>
          </dd>
        </div>
        <div>
          <dt>Reguły cenowe</dt>
          <dd>pricing-rules.config.example.json</dd>
        </div>
        <div>
          <dt>Reguły Excela</dt>
          <dd>excel-rate-update.config.example.json</dd>
        </div>
        <div>
          <dt>Mapowanie lokalizacji</dt>
          <dd>locations.config.json</dd>
        </div>
        <div>
          <dt>Zakres pliku importowego</dt>
          <dd>{model.excel.pickup_date_expansion.rolling_days} dni</dd>
        </div>
        <div>
          <dt>Narzut brokera</dt>
          <dd>Stały, zatwierdzony ręcznie. Bez automatycznej kalibracji.</dd>
        </div>
        <div>
          <dt>Wersja zasad</dt>
          <dd className="hash">{snapshot.source.policyHash}</dd>
        </div>
      </dl>
    </section>
  );
}

function RuleEditor({ rule, isNew, model, remote, onClose, onSave, onDelete }) {
  const dialog = useRef(null);
  const [form, setForm] = useState(
    rule
      ? { ...rule }
      : {
          category: "mandatory",
          groups: ["*"],
          zones: ["*"],
          kind: "all",
          minDays: 2,
          maxDays: 2,
          amount: 60,
          startDate: "",
          endDate: "",
          overrideProtected: false,
        },
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmOverride, setConfirmOverride] = useState(
    Boolean(rule?.overrideProtected),
  );
  const set = (key, value) => setForm({ ...form, [key]: value });
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  async function submit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (form.overrideProtected && !confirmOverride)
        throw new Error(
          "Potwierdź świadome zastosowanie minimum w chronionych terminach.",
        );
      await onSave(form, reason);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  const dateEditable =
    form.category === "protected" ||
    rule?.id.startsWith("scoped:") ||
    (!(
      form.zones?.[0] &&
      form.zones[0] !== "*" &&
      form.category === "mandatory"
    ) &&
      form.category !== "location");
  return (
    <dialog
      ref={dialog}
      className="editor-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      aria-labelledby="editor-title"
    >
      <form onSubmit={submit}>
        <header className="dialog-header">
          <div>
            <h2 id="editor-title">{isNew ? "Nowa reguła" : rule.title}</h2>
            <p>
              {remote ? "Edycja szkicu współdzielonego" : "Edycja szkicu lokalnego"} · PLN brutto / dobę
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            aria-label="Zamknij edycję"
          >
            <X size={20} />
          </button>
        </header>
        <div className="dialog-body">
          {error && (
            <div className="alert error" role="alert">
              <TriangleAlert size={18} />
              {error}
            </div>
          )}
          {isNew && (
            <label>
              Rodzaj reguły
              <select
                aria-label="Rodzaj nowej reguły"
                value={form.category}
                onChange={(e) =>
                  setForm({
                    ...form,
                    category: e.target.value,
                    amount: e.target.value === "protected" ? null : 60,
                    zones: ["*"],
                    groups: ["*"],
                    overrideProtected: false,
                  })
                }
              >
                <option value="mandatory">
                  Minimum klasy we wszystkich lokalizacjach
                </option>
                <option value="protected">Chroniony okres</option>
              </select>
            </label>
          )}
          {isNew && form.category !== "protected" && (
            <div className="form-grid">
              <label>
                Klasa
                <select
                  aria-label="Klasa nowej reguły"
                  value={form.groups[0]}
                  onChange={(e) => set("groups", [e.target.value])}
                >
                  <option value="*">Wszystkie klasy</option>
                  {knownGroups(model).map((group) => (
                    <option key={group}>{group}</option>
                  ))}
                </select>
              </label>
              <div className="readonly-field">
                <span>Lokalizacje</span>
                <strong>Wszystkie</strong>
              </div>
            </div>
          )}
          {!isNew && (
            <div className="editor-scope">
              <MapPin size={17} />
              <div>
                <strong>{scopeText(form, model)}</strong>
                <span>{groupText(form)}</span>
              </div>
            </div>
          )}
          {form.category !== "protected" && (
            <>
              <label>
                Stawka minimalna (PLN / dobę)
                <input
                  autoFocus
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="100000"
                  value={form.amount ?? ""}
                  onChange={(e) =>
                    set(
                      "amount",
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                />
              </label>
              {isNew ? (
                <label>
                  Przedział najmu
                  <select
                    aria-label="Przedział najmu nowej reguły"
                    value={`${form.minDays}-${form.maxDays}`}
                    onChange={(e) => {
                      const [min, max] = e.target.value.split("-").map(Number);
                      setForm({ ...form, minDays: min, maxDays: max });
                    }}
                  >
                    {[
                      [1, 1],
                      [2, 2],
                      [3, 4],
                      [5, 7],
                      [8, 20],
                      [21, 35],
                    ].map(([min, max]) => (
                      <option key={min} value={`${min}-${max}`}>
                        {min}–{max} dni
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="readonly-field">
                  <span>Przedział najmu</span>
                  <strong>{days(form)}</strong>
                </div>
              )}
            </>
          )}
          {dateEditable && (
            <div className="form-grid">
              <label>
                Data startu od
                <input
                  required={form.category === "protected"}
                  type="date"
                  value={form.startDate ?? ""}
                  onChange={(e) => set("startDate", e.target.value)}
                />
              </label>
              <label>
                Data startu do
                <input
                  required={form.category === "protected"}
                  type="date"
                  value={form.endDate ?? ""}
                  min={form.startDate || undefined}
                  onChange={(e) => set("endDate", e.target.value)}
                />
              </label>
            </div>
          )}
          {form.category === "mandatory" &&
            (form.zones?.[0] === "*" || !form.zones?.length) && (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.overrideProtected}
                    onChange={(e) => {
                      set("overrideProtected", e.target.checked);
                      setConfirmOverride(false);
                    }}
                  />
                  <span>Minimum obowiązuje także w chronionych terminach</span>
                </label>
                {form.overrideProtected && (
                  <label className="checkbox-label warning-checkbox">
                    <input
                      type="checkbox"
                      checked={confirmOverride}
                      onChange={(e) => setConfirmOverride(e.target.checked)}
                    />
                    <span>
                      Potwierdzam wyjątek od ochrony cen świątecznych.
                    </span>
                  </label>
                )}
              </>
            )}
          {form.category === "mandatory" && form.zones?.[0] !== "*" && !rule?.id.startsWith("scoped:") && (
            <div className="info-line">
              <ShieldCheck size={18} />
              <span>
                Minimum lokalizacji obejmuje wszystkie klasy bezterminowo.
                Ochrona dat może zablokować korektę w eksporcie Excela.
              </span>
            </div>
          )}
          {remote && <ReasonField value={reason} onChange={setReason} />}
        </div>
        <footer className="dialog-footer">
          {!isNew && ["mandatory", "protected"].includes(form.category) && (
            <button
              type="button"
              className="icon-button danger"
              title="Usuń regułę ze szkicu"
              aria-label="Usuń regułę ze szkicu"
              onClick={async () => {
                setSaving(true);
                try {
                  await onDelete(reason);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
            >
              <Trash2 size={18} />
            </button>
          )}
          <button type="button" className="button" disabled={saving} onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            <Check size={17} />
            Zapisz w szkicu
          </button>
        </footer>
      </form>
    </dialog>
  );
}

createRoot(document.getElementById("root")).render(<App />);
