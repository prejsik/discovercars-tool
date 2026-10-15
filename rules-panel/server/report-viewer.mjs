export function protectedReportHtml(bytes) {
  const html = new TextDecoder().decode(bytes)
    .replace('history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);', 'location.hash = query;')
    .replace('const params = new URLSearchParams(location.search);', 'const params = new URLSearchParams(location.hash.slice(1) || location.search);');
  return new TextEncoder().encode(html);
}
