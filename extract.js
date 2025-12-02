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
    alcohol:      findAlcohol(text, rawText),
    volume:       findVolume(text, rawText),
    lot:          findLot(text, rawText),
    allergens:    findAllergens(text, rawText),
    producer:     findProducer(text, rawText),
    contains:     findContains(text),           // "contiene" / "contient" / "enthält"
    energy:       findEnergy(text),             // kJ + kcal
    denomination: findDenomination(text, rawText),

    // QR: testi classici + URL generici
    qrDetected: /qr.{0,20}code|qrcode|qr\-code|scansiona|scan|ewine|vivino|https?:\/\/|www\./i.test(rawText),

    languages:    detectLanguages(rawText),
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
    new RegExp(`alkoholgehalt[\\.\\s]*${SP}(${NUM})${SP}%`, "i"),            // DE
    new RegExp(`gradazione\\s*alcolica[\\.\\s]*${SP}(${NUM})${SP}%`, "i"),
  ];

  for (const p of patterns) {
    const m = original.match(p);
    if (m) return parseFloat(m[1].replace(",", "."));
  }
  return null;
}

// ==================================================================
// 2. VOLUME → VERSIONE 100% BULLETPROOF (75cl, 750ml, 0.75l, 75de, ecc.)
// ==================================================================
function findVolume(text, original) {
  // uso il testo normalizzato (spazi e minuscole) per evitare casini di OCR
  const s = (text || original || "").toLowerCase().replace(/\s+/g, " ");

  // 1) Caso principale: numero + unità (con spazio opzionale)
  let match = s.match(/(\d{1,4}[.,]?\d*)\s*(cl|ml|l|litro|litri|liters?|litres?)/i);
  if (match) {
    const num = parseFloat(match[1].replace(",", "."));
    const unit = match[2].toLowerCase();

    if (unit === "l" || unit.startsWith("lit")) {
      return +num.toFixed(3);          // es: 0.75 l → 0.750
    }
    if (unit === "cl") {
      return +(num / 100).toFixed(3);  // es: 75 cl → 0.750
    }
    if (unit === "ml") {
      return +(num / 1000).toFixed(3); // es: 750 ml → 0.750
    }
  }

  // 2) Secondo tentativo "sporco": numero 2-3 cifre vicino a qualcosa che pare "cl"
  // (c, ç, c + l/1/I ecc.) — pensato proprio per casi OCR strani
  let loose = s.match(/(\d{2,3})\s*[cç][l1i]/);
  if (loose) {
    const n = parseInt(loose[1], 10);
    if (n >= 50 && n <= 200) {
      return +(n / 100).toFixed(3);    // es: 75 → 0.75 L, 150 → 1.50 L
    }
  }

  // 3) Fallback se l’OCR fa ancora più casino
  if (/\b75\s*cl\b/.test(s)) return 0.75;
  if (/\b0[.,]?75\b/.test(s)) return 0.75;
  if (/\b75\s*d[eé]\b/.test(s)) return 0.75;    // 👈 per "75de 13% vol"
  if (/\b1[.,]?5\b|\b150\s*cl\b/.test(s)) return 1.5;
  if (/\b0[.,]?5\b|\b50\s*cl\b/.test(s)) return 0.5;
  if (/\b0[.,]?375\b|\b37[.,]?5\s*cl\b/.test(s)) return 0.375;
  if (/\b1[.,]?0?\b.*\bl\b/.test(s)) return 1.0;

  return null;
}

// ==================================================================
// 3. LOTTO → ora legge anche "L 89-2025", "L-2025", "L2025"
// ==================================================================
function findLot(text, original) {
  const patterns = [
    /(?:lotto|lote|lot|batch)[\s\:]*([A-Z0-9\-]{4,})/i,
    /L[\s\.\-:]*([A-Z0-9\-]{4,})/i,
    /\bL([A-Z0-9\-]{5,})/i,
  ];
  for (const p of patterns) {
    const m = original.match(p);
    if (m && m[1].length >= 4) return m[1].toUpperCase();
  }
  return null;
}

// ==================================================================
// 4. ALLERGENI – multilingua + varianti
// ==================================================================
function findAllergens(text, original) {
  const map = {
    solfiti:   [/solfiti|sulphites|sulfites|dioxyde|sulfit|so2|anidride\s*solforosa|e220|so₂/i, "solfiti"],
    uova:      [/uova|eggs|œufs|oeufs|huevos/i, "uova"],
    latte:     [/latte|milk|lait|leche|milch/i, "latte"],
    pesce:     [/pesce|fish|poisson|fisch/i, "pesce"],
    crostacei: [/crostacei|crustacés|shellfish/i, "crostacei"],
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
