import React, { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, Search, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { DURATION_BANDS, knownGroups } from "./policy.mjs";
import { floorRequest, locationOptions } from "./editor.mjs";

function MultiSelect({ title, options, selected, onChange }) {
  const [search, setSearch] = useState("");
  const visible = options.filter(item => item.label.toLocaleLowerCase("pl").includes(search.toLocaleLowerCase("pl")));
  return <fieldset className="scope-picker">
    <legend>{title} <span>{selected.length} z {options.length}</span></legend>
    <div className="scope-tools">
      <div className="search-control"><Search size={16} /><input aria-label={`Szukaj: ${title}`} placeholder="Szukaj…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <button type="button" className="icon-button" title={`Zaznacz widoczne: ${title}`} aria-label={`Zaznacz widoczne: ${title}`} onClick={() => onChange([...new Set([...selected, ...visible.map(item => item.value)])])}><CheckCheck size={18} /></button>
      <button type="button" className="icon-button" title={`Wyczyść wybór: ${title}`} aria-label={`Wyczyść wybór: ${title}`} onClick={() => onChange([])}><X size={18} /></button>
    </div>
    <div className="scope-options">
      {visible.map(item => <label className="checkbox-label" key={item.value}><input type="checkbox" checked={selected.includes(item.value)} onChange={event => onChange(event.target.checked ? [...selected, item.value] : selected.filter(value => value !== item.value))} /><span>{item.label}</span></label>)}
      {!visible.length && <p className="muted">Brak wyników.</p>}
    </div>
  </fieldset>;
}

export function ReasonField({ value, onChange }) {
  return <label>Powód zmiany<textarea required minLength={3} maxLength={500} rows={2} value={value} onChange={event => onChange(event.target.value)} /><span className="field-detail">{value.trim().length} / 500</span></label>;
}

export function BusinessEditor({ model, supported, remote, onClose, onSave }) {
  const dialog = useRef(null);
  const [kind, setKind] = useState("mandatory");
  const [groups, setGroups] = useState([]);
  const [zones, setZones] = useState([]);
  const [amounts, setAmounts] = useState(() => DURATION_BANDS.map(() => ""));
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  async function submit(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      const fields = kind === "protected" ? { category: "protected", startDate, endDate } : floorRequest({ groups, zones, startDate, endDate, amounts });
      await onSave(fields, reason);
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="editor-dialog matrix-dialog" aria-labelledby="matrix-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={submit}>
      <header className="dialog-header"><div><h2 id="matrix-title">Nowa reguła</h2><p>{remote ? "Szkic współdzielony" : "Szkic lokalny"} · PLN brutto / dobę</p></div><button type="button" className="icon-button" disabled={saving} onClick={onClose} aria-label="Zamknij edycję"><X size={20} /></button></header>
      <div className="dialog-body">
        {error && <div className="alert error" role="alert"><TriangleAlert size={18} />{error}</div>}
        <label>Rodzaj reguły<select aria-label="Rodzaj nowej reguły" value={kind} onChange={event => setKind(event.target.value)}><option value="mandatory">Minimum dla lokalizacji i klas</option><option value="protected">Chroniony okres</option></select></label>
        {kind === "mandatory" && <>
          <div className="matrix-scopes"><MultiSelect title="Lokalizacje" options={locationOptions(model)} selected={zones} onChange={setZones} /><MultiSelect title="Klasy" options={knownGroups(model).map(value => ({ value, label: value }))} selected={groups} onChange={setGroups} /></div>
          <fieldset className="duration-matrix"><legend>Minimum według długości najmu</legend><div className="duration-inputs">{DURATION_BANDS.map(([min, max], index) => { const label = min === max ? `${min} ${min === 1 ? "dzień" : "dni"}` : `${min}–${max} dni`; return <label key={min}>{label}<input aria-label={`${label} · PLN / dobę`} required type="number" min="0.01" max="100000" step="0.01" value={amounts[index]} onChange={event => setAmounts(values => values.map((value, position) => position === index ? event.target.value : value))} /></label>; })}</div></fieldset>
        </>}
        <div className="form-grid"><label>Data startu od<input type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label>Data startu do<input type="date" required min={startDate || undefined} value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>
        <div className="info-line"><ShieldCheck size={17} /><span>{kind === "protected" ? "Ochrona obejmuje wszystkie lokalizacje i klasy." : "Chronione daty pozostają bez zmian."}</span></div>
        {kind === "mandatory" && !supported && <div className="alert" role="status">Zapis zakresów oczekuje na integrację silnika reguł. Szkic nie zostanie zmieniony.</div>}
        {remote && <ReasonField value={reason} onChange={setReason} />}
      </div>
      <footer className="dialog-footer"><span className="matrix-selection">{kind === "mandatory" ? `${zones.length} lokalizacji · ${groups.length} klas` : "Chroniony okres"}</span><button type="button" className="button" disabled={saving} onClick={onClose}>Anuluj</button><button type="submit" className="button primary" disabled={saving || (kind === "mandatory" && !supported)}><Check size={17} />{saving ? "Zapisywanie…" : "Zapisz w szkicu"}</button></footer>
    </form>
  </dialog>;
}
