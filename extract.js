export function extractData(text) {
  return {
    alcohol: findAlcohol(text),
    volume: findVolume(text),
    lot: findLot(text),
    allergens: findAllergens(text)
  };
}

// ——— FUNZIONI SEMPLICI ———

function findAlcohol(text) {
  const m = text.match(/(\d{1,2}[.,]?\d?)\s*%/);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
}

function findVolume(text) {
  if (/0[.,]?75/.test(text)) return 0.75;
  if (/1[.,]?5/.test(text)) return 1.5;
  return null;
}

function findLot(text) {
  const m = text.match(/L\s?\w+/i);
  return m ? m[0] : null;
}

function findAllergens(text) {
  return /solfit/i.test(text) ? ["solfiti"] : [];
}
