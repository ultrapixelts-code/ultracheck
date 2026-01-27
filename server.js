/**
 * UltraCheck – server.js (performance + affidabilità)
 * - OCR: PDF native + OCR (Vision -> fallback) + merge
 * - QR: jsQR multi-pass + ZXing (natural + binarizzato)
 * - LLM: usa FACTS_JSON come verità + OCR_TEXT solo come contesto
 * - Post-check: forza Valutazione finale coerente con i ❌/⚠️
 * - Sicurezza: limita input, timeout OpenAI, cleanup file sempre
 */

import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import sharp from "sharp";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { parsePdf, pdfToFirstPageImage } from "./pdf.js";
import { ocrGoogle, ocrFallback } from "./ocr.js";
import { cleanOCR } from "./cleanOCR.js";
import dealerRouter from "./dealer.js";
import jsQR from "jsqr";

// ===== ZXING (Node) =====
import {
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  DecodeHintType,
  QRCodeReader
} from "@zxing/library";

// ==============================
// CONFIG
// ==============================
if (process.env.NODE_ENV !== "production") dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ✅ namespacing dealer (evita conflitti)
app.use("/dealer", dealerRouter);

// Homepage
app.get("/", (req, res) => res.sendFile(path.join(process.cwd(), "index.html")));

// Rotta per ultracheck
app.get("/ultracheck", (req, res) => res.sendFile(path.join(process.cwd(), "ultracheck.html")));

// ==============================
// UPLOAD (multer)
// ==============================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${(file.originalname || "upload").replace(/[^\w.\-]+/g, "_")}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ==============================
// OpenAI
// ==============================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==============================
// Google Vision (Render-safe)
// ==============================
let visionClient = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials: creds });
    console.log("Google Vision: configurato da JSON env");
  } catch (err) {
    console.error("Google Vision: JSON non valido →", err.message);
  }
} else {
  console.warn("Google Vision: GOOGLE_APPLICATION_CREDENTIALS_JSON non impostata → OCR Vision disabilitato");
}

// ==============================
// QR – ZXing decode helper
// ==============================
async function zxingDecode(buffer) {
  try {
    const sharpImg = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const luminance = new RGBLuminanceSource(
      new Uint8ClampedArray(sharpImg.data),
      sharpImg.info.width,
      sharpImg.info.height
    );

    const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminance));

    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new QRCodeReader();
    const result = reader.decode(binaryBitmap, hints);

    return result?.getText() || null;
  } catch {
    return null;
  }
}

// ==============================
// QR DETECTION (robusto)
// ==============================
async function detectQrCode(imgBuffer) {
  // 1) jsQR multi-pass
  const jsqrAttempts = [
    { label: "originale", resize: null },
    { label: "1500px", resize: { width: 1500, withoutEnlargement: true } },
    { label: "800px", resize: { width: 800, withoutEnlargement: false } },
  ];

  for (const attempt of jsqrAttempts) {
    try {
      let pipeline = sharp(imgBuffer)
        .rotate()
        .linear(1.4, -(128 * 1.4) + 128)
        .modulate({ brightness: 1.15, contrast: 1.6 })
        .normalise();

      if (attempt.resize) pipeline = pipeline.resize(attempt.resize);

      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: "attemptBoth" });

      if (code?.data) {
        console.log(`QR (jsQR) rilevato → ${attempt.label}`);
        return { detected: true, method: `jsqr:${attempt.label}` };
      }
    } catch {}
  }

  // 2) ZXing natural
  try {
    const zxImg = await sharp(imgBuffer).rotate().toBuffer();
    const result = await zxingDecode(zxImg);
    if (result) {
      console.log("QR rilevato da ZXing!");
      return { detected: true, method: "zxing:natural" };
    }
  } catch {}

  // 3) ZXing binarizzato
  try {
    const binaryImg = await sharp(imgBuffer)
      .rotate()
      .threshold(140)
      .sharpen({ sigma: 1.8 })
      .toBuffer();

    const result2 = await zxingDecode(binaryImg);
    if (result2) {
      console.log("QR rilevato da ZXing (binarizzato)!");
      return { detected: true, method: "zxing:binary" };
    }
  } catch {}

  console.log("Nessun QR rilevato → corretto");
  return { detected: false, method: "none" };
}

// ==============================
// FACTS extraction (deterministico)
// ==============================
function pickFirstMatch(text, re) {
  const m = (text || "").match(re);
  return m?.[0] || "";
}
function sanitizeForLot(text) {
  // Rimuove indicatori tipici di produzione/scheda tecnica che NON sono lotti
  return (text || "").replace(
    /\bL[.\s-]?(PRINTED|STAMPED|FRONTE|FRONT|RETRO|BACK)\b/gi,
    ""
  );
}

function extractFacts(text, lang = "it") {
  const t = text || "";

  const volume = pickFirstMatch(t, /\b(75\s*cl|0[,.]\s*75\s*l|0[,.]75\s*l|750\s*ml)\b/i);
  const abv = pickFirstMatch(t, /\b(\d{1,2}[,.]\d)\s*%\s*vol\b|\b(\d{1,2})\s*%\s*vol\b/i);

  const allergens = pickFirstMatch(t, /\b(contiene\s+solfit[i]?|solfit[i]?|contains\s+sulfites?|sulfites?|contient\s+des\s+sulfites?)\b/i);

  // Lotto: L + subito numero
 const lotText = sanitizeForLot(t);
const lot = pickFirstMatch(lotText, /\bL(?=\d)[0-9A-Z-]{2,}\b/);

  // Producer hints (IT/FR/EN)
  const producer = pickFirstMatch(
    t,
    /\b(imbottigliato\s+da|imbottigliatore|prodotto\s+da|produttore|mis\s+en\s+bouteille\s+par|embouteillé\s+par|bottled\s+by|produced\s+by)\b[\s\S]{0,90}/i
  );

  // Denom hint (euristica minimale)
  const denom = pickFirstMatch(
    t,
    /\b(DOCG|DOC|IGP|IGT|AOC|AOP)\b[\s\S]{0,80}|\b(Merlot|Cabernet|Chardonnay|Pinot\s+Noir|Syrah|Grenache|Sauvignon|Riesling|Nebbiolo|Barbera|Sangiovese)\b/i
  );

  // Lingua: qui mettiamo solo il mercato richiesto
  return {
    langRequested: lang,
    volume,
    abv,
    allergens,
    lot,
    producer,
    denom,
  };
}

// ==============================
// Post-check final evaluation (non fidarti del LLM)
// ==============================
function forceFinalEvaluation(markdown) {
  const hasFail = /❌/.test(markdown);
  const hasWarn = /⚠️/.test(markdown);

  let forced = "Conforme";
  if (hasFail) forced = "Non conforme";
  else if (hasWarn) forced = "Parzialmente conforme";

  if (/\*\*Valutazione finale:\*\*/.test(markdown)) {
    return markdown.replace(/\*\*Valutazione finale:\*\*.*$/m, `**Valutazione finale:** ${forced}`);
  }
  return markdown + `\n\n**Valutazione finale:** ${forced}`;
}

// ==============================
// OpenAI timeout wrapper
// ==============================
async function openaiWithTimeout(promise, ms = 35000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("OpenAI timeout")), ms);
  });

  try {
    const res = await Promise.race([promise, timeout]);
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// ==============================
// ANALYZE endpoint
// ==============================
app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const azienda = String(req.body.azienda || "");
  const nome = String(req.body.nome || "");
  const email = String(req.body.email || "");
  const telefono = String(req.body.telefono || "");
  const lang = String(req.body.lang || "it");

  const t0 = Date.now();

  let fileBuffer = null;
  let extractedText = "";
  let qr = { detected: false, method: "none" };

  try {
    fileBuffer = await fs.readFile(filePath);

    // ==========================
    // 1) TEXT extraction
    // ==========================
    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato:", req.file.originalname);

      // 1. testo nativo
      const { text: pdfText } = await parsePdf(fileBuffer);
      const nativeText = cleanOCR((pdfText || "").replace(/\s+/g, " ").trim());
      const hasGoodNativeText =
        nativeText.length > 120 &&
        /(%|vol\.?|cl|ml|lotto|sulf|kj|kcal|vino|wine|sulfites?)/i.test(nativeText);

      // 2. prima pagina immagine (sempre)
      const imgBuffer = await pdfToFirstPageImage(fileBuffer);
      if (!imgBuffer) throw new Error("Impossibile convertire PDF in immagine");

      // QR
      qr = await detectQrCode(imgBuffer);

      // 3. preprocessing OCR
      const preProcessed = await sharp(imgBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .modulate({ brightness: 1.6, contrast: 1.4 })
        .toBuffer();

      // OCR
      let ocrText = await ocrGoogle(preProcessed, visionClient);
      if (!ocrText?.trim()) {
        console.log("Google Vision fallito → fallback");
        ocrText = await ocrFallback(preProcessed);
      }
      const ocrClean = cleanOCR(ocrText || "");

      // merge migliore
      extractedText = (hasGoodNativeText && nativeText.length > ocrClean.length * 0.7)
        ? (nativeText + "\n" + ocrClean)
        : ocrClean;

    } else {
      console.log("Immagine rilevata:", req.file.mimetype, req.file.originalname);

      // QR sull'immagine originale
      qr = await detectQrCode(fileBuffer);

      // preprocessing OCR
      const preProcessed = await sharp(fileBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .modulate({ brightness: 1.6, contrast: 1.4 })
        .toBuffer();

      let ocrText = await ocrGoogle(preProcessed, visionClient);
      if (!ocrText?.trim()) {
        console.log("Vision fallito (IMG) → fallback");
        ocrText = await ocrFallback(preProcessed);
      }

      extractedText = cleanOCR(ocrText || "");
    }

    if (!extractedText || extractedText.length < 30) {
      throw new Error("Nessun testo leggibile nel file.");
    }

    console.log("TIME extraction(ms):", Date.now() - t0, "| QR:", qr.detected ? "Sì" : "No", "| via:", qr.method);

    // ==========================
    // 2) FACTS (deterministico)
    // ==========================
    const facts = extractFacts(extractedText, lang);
    facts.qrDetected = !!qr.detected;
    facts.qrMethod = qr.method;

    // ==========================
    // 3) LLM: compila report (facts-first)
    // ==========================
    const tAI = Date.now();

    const systemPrompt = `Agisci come un ispettore tecnico UltraCheck AI.
Devi compilare un report di conformità usando SOLO i dati presenti in FACTS_JSON.
OCR_TEXT è solo contesto umano: NON usarlo per dedurre valori.

Principi:
- Se un dato è presente in FACTS_JSON → ✅ conforme (riporta il valore).
- Se un dato non è presente in FACTS_JSON → ❌ mancante.
- Se un dato è presente ma palesemente incompleto (es. produttore senza indirizzo) → ⚠️ parziale.

QR code:
- Usa SOLO FACTS_JSON.qrDetected (true/false) come verità assoluta.

Lotto:
- Se FACTS_JSON.lot è vuoto → ❌ mancante.

Valutazione finale:
- Se almeno uno tra: denominazione, producer, volume, abv, allergens, lot, qrDetected è ❌ → "Non conforme".
- Se nessun ❌ ma almeno un ⚠️ → "Parzialmente conforme".
- Altrimenti → "Conforme".

Devi rispondere esclusivamente nella lingua: ${lang}.

Formato markdown ESATTO:

===============================
### 🔎 Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (✅ conforme / ⚠️ parziale / ❌ mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (✅/⚠️/❌) + testo
Volume nominale: (✅/⚠️/❌) + testo
Titolo alcolometrico: (✅/⚠️/❌) + testo
Indicazione allergeni: (✅/⚠️/❌) + testo
Lotto: (✅/⚠️/❌) + testo
QR code o link ingredienti/energia: (✅/⚠️/❌) + testo
Lingua corretta per il mercato UE: (✅/⚠️/❌) + testo
Altezza minima dei caratteri: ⚠️ non verificabile (assenza analisi grafica)
Contrasto testo/sfondo adeguato: ⚠️ non verificabile (assenza analisi grafica)

**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================

Compila usando FACTS_JSON e non inventare.`;

    const userPayload = [
      { type: "text", text: "FACTS_JSON:\n" + JSON.stringify(facts, null, 2) },
      // OCR_TEXT lo lasciamo come contesto (puoi rimuoverlo se vuoi ancora più rigore)
      { type: "text", text: "OCR_TEXT:\n" + extractedText },
    ];

    const response = await openaiWithTimeout(
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPayload },
        ],
      }),
      35000
    );

    console.log("TIME AI(ms):", Date.now() - tAI);

    let analysis = response?.choices?.[0]?.message?.content || "Nessuna risposta dall'IA.";
    analysis = forceFinalEvaluation(analysis);

    // ==========================
    // 4) Email (opzionale)
    // ==========================
    if (fileBuffer && process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);

        await sgMail.send({
          to: process.env.MAIL_TO,
          from: "gabriele.russian@ultrapixel.it",
          subject: `UltraCheck: ${azienda || "Analisi etichetta"}`,
          text: `
Analisi completata per:

• Nome: ${nome || "(non fornito)"}
• Azienda: ${azienda || "(non fornita)"}
• Email: ${email || "(non fornita)"}
• Telefono: ${telefono || "(non fornito)"}
• QR: ${facts.qrDetected ? "Sì" : "No"} (${facts.qrMethod})

-----------------------------
RISULTATO ANALISI:
-----------------------------

${analysis}
          `,
          attachments: [
            {
              content: fileBuffer.toString("base64"),
              filename: req.file.originalname,
              type: req.file.mimetype,
              disposition: "attachment",
            },
          ],
        });

        console.log("📧 Email inviata a", process.env.MAIL_TO);
      } catch (err) {
        console.warn("❌ Email fallita:", err.message);
      }
    }

    console.log("TIME total(ms):", Date.now() - t0);
    return res.json({ result: analysis });

  } catch (error) {
    console.error("Errore:", error.message);
    return res.status(500).json({ error: "Elaborazione fallita: " + error.message });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

// ==============================
// TEST Google Vision
// ==============================
app.get("/test-vision", async (req, res) => {
  if (!visionClient) {
    return res.status(500).send("Google Vision non configurato. Controlla GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
  try {
    const testImage = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64"
    );
    const [result] = await visionClient.textDetection({ image: { content: testImage } });
    const text = result.fullTextAnnotation?.text || "(nessun testo rilevato)";
    res.send(
      `<h2>Google Vision API: OK</h2><p><strong>Risultato OCR:</strong> "${text}"</p><hr><p>Puoi rimuovere questo endpoint in produzione.</p>`
    );
  } catch (err) {
    console.error("Test Vision fallito:", err.message);
    res.status(500).send(`<h2>Errore Google Vision</h2><pre>${err.message}</pre>`);
  }
});

// ==============================
// START
// ==============================
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck LIVE su http://0.0.0.0:${port}`);
  console.log(`URL: https://ultracheck.onrender.com`);
});
