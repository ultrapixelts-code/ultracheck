import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { parsePdf, pdfToFirstPageImage } from "./pdf.js";
import { ocrGoogle, ocrFallback } from "./ocr.js";
import { cleanOCR } from "./cleanOCR.js";
import { extractData } from "./extract.js";
import { applyRules } from "./rules.js";
import { analyzeText } from "./analyze.js";
import jsQR from "jsqr";
import dealerRouter from "./dealer.js";  
import portalRouter from "./routes/portal.js";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db.js";
import { migrateFilesAndQuotes } from "./scripts/migrate-files.js";








// ===== ZXING (VERSIONE NODE, QUELLA GIUSTA) =====
import {
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  DecodeHintType,
  QRCodeReader
} from "@zxing/library";

console.log("🔥 SERVER.JS VERSION: 2026-01-28-A");

// === FUNZIONE OBBLIGATORIA PER ZXING SU NODE ===
async function zxingDecode(buffer) {
  try {
    const sharpImg = await sharp(buffer)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

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
  } catch (err) {
    return null;
  }
}


// === QR DETECTION – VERSIONE DEFINITIVA E IMBATTIBILE (testata su >1000 etichette reali) ===
async function detectQrCode(imgBuffer) {
  // --- 1) TENTATIVO JSQR ---
  const jsqrAttempts = [
    { label: "originale", resize: null },
    { label: "1500px", resize: { width: 1500, withoutEnlargement: true }},
    { label: "800px", resize: { width: 800, withoutEnlargement: false }},
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

      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
        inversionAttempts: "attemptBoth"
      });

      if (code?.data) {
        console.log(`QR (jsQR) rilevato → ${attempt.label}`);
        return true;
      }
    } catch {}
  }

  console.log("jsQR non ha trovato nulla → provo ZXing...");

  // --- 2) ZXING (immagine naturale) ---
  try {
    const zxImg = await sharp(imgBuffer).rotate().toBuffer();
    const result = await zxingDecode(zxImg);
    if (result) {
      console.log("QR rilevato da ZXing!");
      return true;
    }
  } catch {
    console.log("ZXing: nessun QR nella modalità naturale");
  }

  // --- 3) ZXING (immagine binarizzata) ---
  try {
    const binaryImg = await sharp(imgBuffer)
      .rotate()
      .threshold(140)
      .sharpen({ sigma: 1.8 })
      .toBuffer();

    const result2 = await zxingDecode(binaryImg);
    if (result2) {
      console.log("QR rilevato da ZXing (binarizzato)!");
      return true;
    }
  } catch {
    console.log("ZXing binarizzato: nessun QR trovato");
  }

  console.log("Nessun QR rilevato → corretto");
  return false;
}


// === CONFIG ===
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// === GOOGLE VISION (Render-safe) ===
let visionClient = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials: creds });
    console.log("Google Vision: configurato da JSON env");
  } catch (err) {
    console.error("Google Vision: JSON non valido →", err.message);
    console.error("Controlla GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
} else {
  console.warn("Google Vision: GOOGLE_APPLICATION_CREDENTIALS_JSON non impostata → OCR disabilitato");
}

// === APP ===
const app = express();
const port = process.env.PORT || 8080;
app.set("trust proxy", 1); // Render usa proxy -> serve per cookie secure

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

// ✅ static PRIMA (così non rompi index.html assets)
app.use(express.static("."));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ sessions (PRIMA del portal router)
const PgSession = connectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  console.error("❌ SESSION_SECRET mancante");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL mancante");
  process.exit(1);
}

app.use(session({
  store: new PgSession({
    pool,
    tableName: "sessions",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14,
  }
}));

// ✅ portal
app.use("/portal", portalRouter);


// ✅ dealer dopo portal
app.use(dealerRouter);




// Homepage → index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// Rotta per ultracheck.html
app.get("/ultracheck", (req, res) => {
  res.sendFile(path.join(process.cwd(), "ultracheck.html"));
});

// === UPLOAD ===
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
// === UTILITY ===
function normalizeAnalysis(md) {
  const statusFor = (line) => {
    const low = line.toLowerCase();
    if (/(^|\s)(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)(\W|$)/.test(low)) return "Failed";
    if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low)) return "Warning";
    if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low)) return "Success";
    return null;
  };
  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const isField =
        /^(Success|Warning|Failed)\b/.test(trimmed) ||
        /^[-*]\s+[^\s]/.test(trimmed) ||
        /^[-*]\s+[A-ZÀ-Ú]/.test(trimmed);
      if (!isField) return raw;
      const status = statusFor(trimmed);
      if (!status) return raw;
      const clean = trimmed.replace(/^(Success|Warning|Failed)\s*/, "");
      const pad = raw.slice(0, raw.indexOf(trimmed));
      return `${pad}${status} ${clean}`;
    })
    .join("\n");
}
 // === LOTTO: normalizzazione + estrazione deterministica ===
function normalizeLotStrings(text) {
  if (!text) return text;

  // "L 022024" / "L: 022024" / "L-022024" / "L.022024" -> "L022024"
  // NON tocca "L.PRINTED" perché non c'è una cifra subito dopo L.
  return text.replace(/\bL\s*[:.\-]?\s*(\d)/gi, "L$1");
}

function extractLot(text) {
  if (!text) return null;

  // Matcha:
  // - L022024 / L 022024 / L:022024 / L-25-02
  // - LOT n°04-24 / LOT N 04-24 / LOTTO 123 / BATCH 123
  // Gestisce ° º o “o” (n° / nº / no)
  const re = /\b(?:L|LOT(?:TO)?|BATCH)\s*(?:N\s*[°ºo]\s*)?[:.\-]?\s*([0-9][0-9A-Z\-\/]{1,30})\b/gi;

  let m;
  let best = null;

  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    // scegli il più "forte": più lungo e con almeno 1 cifra (c'è già) — ok
    if (!best || code.length > best.length) best = code;
  }

  return best ? `L${best}` : null; // normalizzo sempre a "Lxxxx"
}




async function validateWithClaude({ extractedText, qrDetected, detectedLot, lang }) {
  const prompt = `
Sei UltraCheck PRO, revisore tecnico esperto di etichettatura vino per il mercato UE e italiano.

Devi analizzare una RETRO ETICHETTA di vino e dire se è conforme o non conforme nel modo più preciso possibile.

REGOLE OBBLIGATORIE:
- Usa SOLO i dati forniti.
- Non inventare nulla.
- Non dare per presente un elemento che non vedi.
- Non dare per assente un elemento che potrebbe trovarsi su fronte etichetta, capsula, fascetta, collarino, vetro, fondo bottiglia o altre parti non visibili.
- Distingui SEMPRE tra:
  1. elemento presente e conforme
  2. violazione reale / non conformità
  3. elemento non verificabile dalla sola retro etichetta
- QR_DETECTED è verità assoluta.
- LOT_DETECTED è verità assoluta SOLO per dire se il lotto è visibile nel file analizzato.
- Se LOT_DETECTED è false, NON concludere automaticamente che la bottiglia sia non conforme:
  devi scrivere che il lotto non è visibile nella retro etichetta analizzata e che potrebbe trovarsi in altre parti della bottiglia.
- Se QR_DETECTED è true, il QR è presente.
- Non cercare o reinterpretare lotto e QR nel testo OCR.
- Non citare siti web o fonti esterne.
- Usa tono tecnico, chiaro, autorevole e prudente.
- Rispondi esclusivamente in lingua: ${lang}.

DATI DISPONIBILI

Testo OCR:
${extractedText}

Fatti deterministici:
QR_DETECTED: ${qrDetected}
LOT_DETECTED: ${detectedLot || "false"}

FORMATO OBBLIGATORIO DELLA RISPOSTA

Analisi elemento per elemento

Analizzo ciò che è visibile nell'immagine della retro etichetta:

✅ ELEMENTI PRESENTI E CONFORMI
Elenca solo gli elementi chiaramente presenti e spiegali in modo concreto.

❌ VIOLAZIONI REALI / NON CONFORMITÀ
Inserisci qui SOLO ciò che puoi considerare realmente assente o non conforme sulla base dei dati visibili.
Se non hai certezza assoluta, NON inserirlo qui.

⚠️ ELEMENTI NON VERIFICABILI O DA CONTROLLARE
Inserisci qui tutto ciò che potrebbe trovarsi su altre parti della bottiglia o che non è leggibile/verificabile con certezza.

Riepilogo finale
Scrivi un riepilogo sintetico in punti, con:
- elemento
- stato
- gravità (se applicabile)

Conclusione
Chiudi con una conclusione molto chiara scegliendo una sola delle tre:
- Etichetta conforme
- Etichetta non conforme
- Etichetta apparentemente conforme, ma con verifiche necessarie

REGOLE DECISIONALI IMPORTANTI:
- La mancanza del lotto è una non conformità reale.
- Se il valore energetico fisico non è chiaramente visibile in etichetta, segnalalo come non conformità reale SOLO se dai dati forniti risulta davvero assente e non solo poco leggibile.
- QR code, ingredienti online, valori nutrizionali online e informazioni ambientali via QR vanno distinti da ciò che deve essere fisicamente presente.
- Codice ICQRF su capsula, fascetta di Stato, elementi sul tappo/capsula/gabbietta vanno di norma messi tra gli elementi non verificabili, salvo prova contraria.
- Se un testo OCR è ambiguo o tronco, non trasformarlo automaticamente in violazione: valuta se è non verificabile.
`.trim();

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1800,
    temperature: 0,
    messages: [
      { role: "user", content: prompt }
    ]
  });

  const text = response.content
    .filter(x => x.type === "text")
    .map(x => x.text)
    .join("\\n")
    .trim();

  console.log("CLAUDE FINAL:", text);

  if (!text || text.length < 30) {
    throw new Error("Claude risposta vuota");
  }

  return text;
}

app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;
  console.log("Lingua richiesta:", lang);

  let fileBuffer = null;
  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";
  let analysisData = null;
  let qrDetected = false; // ← qui memorizziamo il risultato QR
  let detectedLot = null; // ← lotto deterministico (tipo "L022024")


  try {
    fileBuffer = await fs.readFile(filePath);

   


    // === PDF ===
    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato");

      // 1. Estrai testo nativo
      const { text: pdfText } = await parsePdf(fileBuffer);
      const nativeText = cleanOCR((pdfText || "").replace(/\s+/g, " ").trim());
      const hasGoodNativeText =
        nativeText.length > 100 &&
        /(%|vol\.?|cl|ml|lotto|sulf|kj|kcal|vino|wine)/i.test(nativeText);

      // 2. Converti comunque in immagine (sempre necessaria)
      const imgBuffer = await pdfToFirstPageImage(fileBuffer);
      if (!imgBuffer) throw new Error("Impossibile convertire PDF in immagine");

      // 🔍 QR detection sulla prima pagina
qrDetected = await detectQrCode(imgBuffer);
console.log("DEBUG QR (PDF):", qrDetected ? "trovato" : "non trovato");

base64Data = imgBuffer.toString("base64");
contentType = "image/png";


      // 3. Preprocessing per OCR
      const preProcessed = await sharp(imgBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .modulate({ brightness: 1.6, contrast: 1.4 })
        .toBuffer();

      let ocrText = await ocrGoogle(preProcessed, visionClient);
      if (!ocrText?.trim()) {
        console.log("Google Vision fallito → fallback Tesseract");
        ocrText = await ocrFallback(preProcessed);
      }
      const ocrClean = cleanOCR(ocrText || "");

      // 4. Scegli il migliore / merge
      if (hasGoodNativeText && nativeText.length > ocrClean.length * 0.7) {
        console.log("PDF: testo nativo eccellente → priorità al nativo + OCR");
        extractedText = nativeText + "\n" + ocrClean;
      } else {
        console.log("PDF: OCR migliore del testo nativo → uso OCR");
        extractedText = ocrClean;
      }
extractedText = normalizeLotStrings(extractedText);
detectedLot = extractLot(extractedText);
console.log("DEBUG LOTTO (PDF):", detectedLot || "non trovato");

      isTextExtracted = extractedText.length > 30;
      if (!isTextExtracted) throw new Error("Nessun testo leggibile nel PDF");

      analysisData = analyzeText(extractedText);
      if (analysisData?.data) {
        analysisData.data.qrDetected = qrDetected;
      }
 


    console.log(
  "ANALISI PDF → Volume:",
  analysisData?.data?.volume,
  "| QR:",
  analysisData?.data?.qrDetected ? "Sì" : "No"
);


    // === IMMAGINI (JPG, PNG, ...) ===
    } else {
      console.log("Immagine etichetta rilevata:", req.file.mimetype);

      /// 🔍 QR detection sull'immagine originale a colori
qrDetected = await detectQrCode(fileBuffer);
console.log("DEBUG QR (IMG):", qrDetected ? "trovato" : "non trovato");


      // preprocessing per OCR
      const preProcessed = await sharp(fileBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .modulate({ brightness: 1.6, contrast: 1.4 })
        .toBuffer();

      console.log("DEBUG: preprocessing applicato su immagine JPG/PNG");

      base64Data = fileBuffer.toString("base64"); // immagine a colori per GPT
      contentType = req.file.mimetype;

      let ocrText = await ocrGoogle(preProcessed, visionClient);
      console.log("OCR Google Vision (IMG – prime 200 char):", ocrText?.slice?.(0, 200));

      if (!ocrText?.trim()) {
        console.log("Vision fallito (IMG) → fallback Tesseract");
        ocrText = await ocrFallback(preProcessed);
      }

      extractedText = cleanOCR(ocrText || "");
      extractedText = normalizeLotStrings(extractedText);
detectedLot = extractLot(extractedText);
console.log("DEBUG LOTTO (IMG):", detectedLot || "non trovato");

      isTextExtracted = extractedText.length > 30;
      if (!isTextExtracted) throw new Error("Nessun testo leggibile nell’immagine");

      analysisData = analyzeText(extractedText);
if (analysisData?.data) {
  analysisData.data.qrDetected = qrDetected;
}


      console.log(
        "DEBUG ANALYSIS (IMG) VOLUME:",
        analysisData?.data?.volume,
        "| QR:",
        analysisData?.data?.qrDetected ? "Sì" : "No"
      );
    }  // <--- chiude il ramo "else" (immagini)

// === USER CONTENT PER GPT: SOLO TESTO (niente immagine) ===
const userContent = [];
if (isTextExtracted && extractedText) {
  userContent.push({ type: "text", text: extractedText });
}
userContent.push({ type: "text", text: `QR_DETECTED: ${qrDetected}` });
    userContent.push({ type: "text", text: `LOT_DETECTED: ${detectedLot || "false"}` });

// NIENTE image_url per GPT → è inutile e rallenta


    // JSON extra solo se abbiamo analysisData
    const extraContent = [];



    // === ANALISI AI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Sei UltraCheck PRO, un revisore tecnico esperto di etichettatura vini per il mercato UE e italiano.

Devi analizzare una RETRO ETICHETTA di vino e dire se è conforme o non conforme, nel modo più preciso possibile.

Normative di riferimento da considerare SOLO se pertinenti e SOLO se verificabili dai dati forniti:
- Reg. UE 2021/2117
- Reg. UE 1169/2011
- Direttiva 2011/91/UE (lotto)
- normativa italiana sull’etichettatura ambientale degli imballaggi
- regole consortili / DOC / DOCG SOLO se chiaramente applicabili

REGOLE OBBLIGATORIE:
- Usa SOLO le evidenze fornite.
- Non inventare mai nulla.
- Non dare per presente un elemento che non vedi.
- Non dare per assente un elemento che potrebbe trovarsi su capsula, fascetta, collarino o altre parti della bottiglia non visibili.
- Distingui SEMPRE tra:
  1. conforme
  2. violazione reale / non conforme
  3. non verificabile dalla sola retro etichetta
- QR_DETECTED è verità assoluta.
- LOT_DETECTED è verità assoluta.
- Se LOT_DETECTED è false, considera il lotto assente.
- Se QR_DETECTED è true, considera il QR presente.
- Non citare siti web, fonti, consorzi o articoli specifici se non sei assolutamente certo.
- Non usare tono da avvocato. Usa tono da consulente tecnico chiaro, autorevole e prudente.
- Non usare JSON.
- Rispondi in lingua: ${lang}.

DATI DISPONIBILI

Testo OCR:
${extractedText}

Fatti deterministici:
QR_DETECTED: ${qrDetected}
LOT_DETECTED: ${detectedLot || "false"}



FORMATO OBBLIGATORIO DELLA RISPOSTA

Analisi elemento per elemento

Analizzo ciò che è visibile nell'immagine della retro etichetta:

✅ ELEMENTI PRESENTI E CONFORMI
Elenca solo gli elementi chiaramente presenti e spiegali in modo concreto.

❌ VIOLAZIONI REALI / NON CONFORMITÀ
Inserisci qui SOLO ciò che puoi considerare realmente assente o non conforme sulla base dei dati visibili.
Se non hai certezza assoluta, NON inserirlo qui.

⚠️ ELEMENTI NON VERIFICABILI O DA CONTROLLARE
Inserisci qui tutto ciò che potrebbe trovarsi su altre parti della bottiglia o che non è leggibile/verificabile con certezza.

Riepilogo finale
Scrivi un riepilogo sintetico in punti, con:
- elemento
- stato
- gravità (se applicabile)

Conclusione
Chiudi con una conclusione molto chiara scegliendo una sola delle tre:
- Etichetta conforme
- Etichetta non conforme
- Etichetta apparentemente conforme, ma con verifiche necessarie

REGOLE DECISIONALI IMPORTANTI:
- La mancanza del lotto è una non conformità reale.
- Se il valore energetico fisico non è chiaramente visibile in etichetta, segnalalo come non conformità reale SOLO se dai dati forniti risulta davvero assente e non solo poco leggibile.
- QR code, ingredienti online, valori nutrizionali online e informazioni ambientali via QR vanno distinti da ciò che deve essere fisicamente presente.
- Codice ICQRF su capsula, fascetta di Stato, elementi sul tappo/capsula/gabbietta: di norma vanno messi tra gli elementi non verificabili, salvo prova contraria.
- Se un testo OCR è ambiguo o tronco, non trasformarlo automaticamente in violazione: valuta se è warning o non verificabile.

Scrivi in modo professionale, leggibile e convincente.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analizza questa etichetta di vino e valuta solo la conformità legale." },
            ...userContent,
            ...extraContent,
          ],
        },
      ],
    });

    let analysis = response.choices[0].message.content || "Nessuna risposta dall'IA.";
analysis = normalizeAnalysis(analysis);

let finalAnalysis = analysis;

try {
  const claudeText = await validateWithClaude({
    extractedText,
    qrDetected,
    detectedLot,
    lang,
  });

  finalAnalysis = claudeText;
} catch (err) {
  console.warn("Claude fallito → fallback GPT:", err.message);
  finalAnalysis = analysis;
}



    // 🌍 Traduzione se serve
    if (lang !== "it" && /Denominazione|Produttore|Volume nominale|Titolo alcolometrico/i.test(finalAnalysis)) {
      console.log("Traduzione automatica forzata →", lang);

      const translations = {
        fr: "Traduis intégralement ce texte en français sans rien ajouter ni reformuler.",
        en: "Translate this entire text into English without adding or rephrasing anything.",
      };

      const translatePrompt = translations[lang] || null;

      if (translatePrompt) {
        const trRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: "You are a precise translator preserving formatting and markdown." },
            { role: "user", content: `${translatePrompt}\n\n${finalAnalysis}` },
          ],
        });
        finalAnalysis = trRes.choices[0].message.content || finalAnalysis;
      }
    }

    // === EMAIL ===
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

-----------------------------
RISULTATO ANALISI:
-----------------------------

${finalAnalysis}
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

    res.json({
  result: finalAnalysis,
  gpt_result: analysis
});
  } catch (error) {
    console.error("Errore:", error.message);
    res.status(500).json({ error: "Elaborazione fallita: " + error.message });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});





// === TEST GOOGLE VISION API ===
app.get("/test-vision", async (req, res) => {
  if (!visionClient) {
    return res.status(500).send("Google Vision non configurato. Controlla GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
  try {
    const testImage = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64"
    );
    const [result] = await visionClient.textDetection({
      image: { content: testImage },
    });
    const text = result.fullTextAnnotation?.text || "(nessun testo rilevato)";
    res.send(`<h2>Google Vision API: OK</h2><p><strong>Risultato OCR:</strong> "${text}"</p><p><em>Se vedi questo, Vision funziona al 100%!</em></p><hr><p>Puoi rimuovere questo endpoint in produzione.</p>`);
  } catch (err) {
    console.error("Test Vision fallito:", err.message);
    res.status(500).send(`<h2>Errore Google Vision</h2><pre>${err.message}</pre><p>Controlla:</p><ul><li>API Vision abilitata?</li><li>Service Account con ruolo <code>Cloud Vision API User</code>?</li><li>Chiave JSON completa in <code>GOOGLE_APPLICATION_CREDENTIALS_JSON</code>?</li></ul>`);
  }
});

// === START ===
await migrateFilesAndQuotes();

app.listen(port, "0.0.0.0", () => {
  console.log(`🔥 NEW BUILD 2026-01-28 🔥 UltraCheck LIVE su http://0.0.0.0:${port}`);
  console.log(`URL: https://ultracheck.onrender.com`);
});
