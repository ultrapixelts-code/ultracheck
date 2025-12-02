export function applyRules(data) {
  const results = [];

  // Alcol obbligatorio
  if (!data.alcohol) {
    results.push({ field: "alcohol", level: "error", message: "Titolo alcolometrico mancante" });
  } else {
    results.push({ field: "alcohol", level: "ok" });
  }

  // Volume obbligatorio
  if (!data.volume) {
    results.push({ field: "volume", level: "error", message: "Volume nominale mancante" });
  } else {
    results.push({ field: "volume", level: "ok" });
  }

  // Lotto
  if (!data.lot) {
    results.push({ field: "lot", level: "warning", message: "Lotto non trovato" });
  } else {
    results.push({ field: "lot", level: "ok" });
  }

  return results;
}
