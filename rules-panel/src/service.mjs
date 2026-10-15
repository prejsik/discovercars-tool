export function createService(fetcher = (...args) => fetch(...args)) {
  let configured = false;
  async function request(path, body) {
    const response = await fetcher(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json", "X-Panel-Request": "1" }, body: JSON.stringify(body) }),
    });
    const json = response.headers.get("content-type")?.includes("application/json");
    const data = json ? await response.json() : null;
    if (path === "/api/workspace" && !configured &&
      ([404, 501].includes(response.status) || (response.ok && !json))) return null;
    if (!response.ok) {
      const message = typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message;
      const error = new Error(message || `Żądanie nie powiodło się (HTTP ${response.status}). Ponów po sprawdzeniu połączenia.`);
      error.status = response.status;
      error.code = response.status === 409 ? "DRAFT_CONFLICT" : "API_ERROR";
      error.details = data?.details;
      if (Array.isArray(error.details)) {
        const details = error.details.map(item => typeof item === "string" ? item : item?.message).filter(Boolean);
        if (details.length) error.message += ` ${details.join(" ")}`;
      }
      throw error;
    }
    if (!data) throw new Error("Serwer zwrócił nieprawidłową odpowiedź. Nie zapisano zmian.");
    return data;
  }
  async function workspace() {
    const data = await request("/api/workspace");
    if (data) {
      if (!data.snapshot?.documents || !data.snapshot.source?.policyHash || !data.capabilities)
        throw new Error("Nieobsługiwany format danych workspace.");
      configured = true;
      return data;
    }
    const snapshot = await request("/policy-snapshot.json");
    if (snapshot.schemaVersion !== 1 || !snapshot.documents || !snapshot.source?.policyHash)
      throw new Error("Nieobsługiwana wersja danych panelu.");
    return { snapshot, draft: null, preview: null, history: [], status: { available: false }, capabilities: { sharedDraft: false, publish: false, preview: false } };
  }
  return {
    workspace,
    async save(input) {
      const reason = input.reason?.trim() ?? "";
      if (reason.length < 3 || reason.length > 500) throw new Error("Powód zmiany musi mieć od 3 do 500 znaków.");
      return request("/api/draft", { ...input, reason });
    },
    preview: draftRevision => request("/api/preview", { draftRevision }),
    publish: (draftRevision) => request("/api/publish", { draftRevision }),
    checkBaseline: input => request('/api/baseline/check', input),
    publishBaseline: input => request('/api/baseline/publish', input),
    checkReportBaseline: input => request('/api/report-baseline/check', input),
    publishReportBaseline: input => request('/api/report-baseline/publish', input),
    rollback: (revision, expectedRevision) => request("/api/rollback", { revision, expectedRevision }),
  };
}
