// utils/extractData.js
// Versione PRO – UltraCheck 2025
// Testata su DOCG/DOC/IGT, etichette con QR, francesi, tedesche, spagnole

const normalize = (str) => str.toLowerCase().replace(/\s+/g, " ").trim();

// --- PATTERN RIUTILIZZABILI ---
const NUM = "\\d{1,4}[.,]?\\d{0,2}";
const SP  = "\\s*"; // spazi, a capo, ecc.

export function extractData(rawText) {
  const text = " " + normalize(rawText) + " "; // padding per regex più sicuri

  return {
    alcohol:        findAlcohol(text, rawText),
    volume:         findVolume(text, rawText),
    lot:            findLot(text, rawText),
    allergens:      findAllergens(text, rawText),
    producer:       findProducer(text, rawText),
    contains:       findContains(text),           // "contiene" / "contient" / "enthält"
    energy:         findEnergy(text),             // kJ + kcal
    denomination:   findDenomination(text, rawText),
    qrDetected:     /qr.{0,20}code|scansiona|scan|ewine|vivino|https?:\/\//i.test(rawText),
    languages:      detectLanguages(rawText),
  };
}

// ==================================================================
// 1. ALCOOL – gestisce tutti i formati reali
// ==================================================================
function findAlcohol(text, original) {
  const patterns = [
    new RegExp(`alc(?:ool|ohol)?[\\.\\s]*${SP}(${NUM})${SP}%`, "i"),
    new RegExp(`(${NUM})${SP}%${SP}(?:vol|alc|by\\s*vol)`, "i"),
    new RegExp(`titre\\s*alcoolique?[\\.\\s]*${SP}(${NUM})${SP}%`, "i"),     // FR
    new RegExp(`alkoholgehalt[\\.\\s]*${SP}(${NUM})${SP}%`, "i"),          // DE
    new RegExp(`gradazione\\s*alcolica[\\.\\s]*${SP}(${NUM})${SP}%`, "i"),
  ];

  for (const p of patterns) {
    const m = original.match(p);
    if (m) return parseFloat(m[1].replace(",", "."));
  }
  return null;
}

// ==================================================================
// 2. VOLUME – 0.75 / 75 cl / 750 ml / 1,5 L / 150 cl / 1.500 ml
// ==================================================================
function findVolume(text, original) {
  const patterns = [
    /(?:^|\s)(0[.,]75|0\.75|75\s?cl|750\s?ml|0,75\s?[lL])\b/i,
    /(?:^|\s)(1[.,]5|1\.5|1,5|150\s?cl|1\.5\s?[lL]|1\.500\s?ml)\b/i,
    /(?:^|\s)(0[.,]5|0\.5|50\s?cl|500\s?ml)\b/i,
    /(?:^|\s)(0[.,]375|0\.375|37\.5\s?cl|375\s?ml)\b/i,
    /(?:^|\s)(1[.,]0|1\.0|100\s?cl|1\s?[lL])\b/i,
  ];

  for (const p of patterns) {
    const m = original.match(p);
    if (m) {
      const found = m[0].toLowerCase();
      if (found.includes("1.5") || found.includes("1,5") || found.includes("150")) return 1.5;
      if (found.includes("0.75") || found.includes("0,75") || found.includes("75 cl") || found.includes("750 ml")) return 0.75;
      if (found.includes("0.5") || found.includes("50 cl") || found.includes("500 ml")) return 0.5;
      if (found.includes("0.375") || found.includes("37.5 cl") || found.includes("375 ml")) return 0.375;
      if (found.includes("1") && found.includes("l")) return 1.0;
    }
  }
  return null;
}

// ==================================================================
// 3. LOTTO – L12345, L. 12345, Lotto L12345, Lot, Batch, L...
// ==================================================================
function findLot(text, original) {
  const patterns = [
    /(?:lotto|lote|batch|lot)\.?\s*:?\s*([A-Z0-9]{3,})/i,
    /L\s*[:\-\.]?\s*([A-Z0-9]{3,})/i,
    /L([A-Z0-9]{4,})/i,
  ];

  for (const p of patterns) {
    const m = original.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// ==================================================================
// 4. ALLERGENI – multilingua + varianti
// ==================================================================
function findAllergens(text, original) {
  const map = {
    solfiti:       [/solfiti|sulphites|sulfites|dioxyde|sulfit|so2|anidride\s*solforosa|e220|so₂/i, "solfiti"],
    uova:          [/uova|eggs|œufs|oeufs|huevos/i, "uova"],
    latte:         [/latte|milk|lait|leche|milch/i, "latte"],
    pesce:         [/pesce|fish|poisson|fisch/i, "pesce"],
    crostacei:     [/crostacei|crustacés|shellfish/i, "crostacei"],
  };

  const found = [];
  for (const [key, [regex]] of Object.entries(map)) {
    if (regex.test(original)) found.push(map[key][1]);
  }
  return found;
}

// ==================================================================
// 5. PRODUTTORE / IMBOTTIGLIATORE
// ==================================================================
function findProducer(text, original) {
  const patterns = [
    /(?:imbottigliato|prodotto|produttore|mis\s+en\s+bouteille|abgefüllt)\s+(?:da|per|par|von)?\s*[:\-]?\s*([a-z\s'\.]+(?:s\.?r\.?l|s\.?a|sas|az\.?\s*agr\.?)[^0-9]{10,})/i,
    /(?:prodotto|prodotto e imbottigliato) (?:da)?\s*([A-Z][a-z\s'\.]+(?:Cantina|Società|Cooperative)[^0-9]{10,})/i,
  ];

  for (const p of patterns) {
    const m = original.match(p);
    if (m) {
      return m[1]
        .replace(/[^\w\s'\.\-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return null;
}

// ==================================================================
// 6. "CONTIENE" – frase obbligatoria
// ==================================================================
function findContains(text) {
  return {
    it: /contiene\s+solf/i.test(text),
    fr: /contient\s+sulfit/i.test(text),
    de: /enthält\s*sulfit/i.test(text),
    en: /contains\s+sulph/i.test(text),
  };
}

// ==================================================================
// 7. VALORI ENERGETICI
// ==================================================================
function findEnergy(text) {
  const kj = text.match(/(\d+)\s*kj/i)?.[1];
  const kcal = text.match(/(\d+)\s*kcal/i)?.[1];
  return { kj: kj ? parseInt(kj) : null, kcal: kcal ? parseInt(kcal) : null };
}

// ==================================================================
// 8. DENOMINAZIONE (DOC/DOCG/IGT)
// ==================================================================
function findDenomination(text, original) {
  const m = original.match(/(DOCG|DOC|DOP|IGP|IGT)\s+([A-Za-zÀ-ú\s'’-]+)/i);
  if (m) {
    return {
      type: m[1].toUpperCase(),
      name: m[2].trim().replace(/\s+/g, " "),
    };
  }
  return null;
}

// ==================================================================
// 9. LINGUE RILEVATE (base)
// ==================================================================
function detectLanguages(text) {
  const langs = [];
  if (/[àèéìòù]/i.test(text)) langs.push("it");
  if (/[àâäéèêëîïôöùûüç]/i.test(text)) langs.push("fr");
  if (/[äöüß]/i.test(text)) langs.push("de");
  if (/[ñ]/i.test(text)) langs.push("es");
  if (/[áéíóú]/i.test(text)) langs.push("pt");
  return [...new Set(langs)];
}
