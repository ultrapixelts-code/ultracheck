import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import { PDFDocument as PDFLibDocument } from "pdf-lib";
import { createCanvas } from "canvas";

/**
 * Converte la prima pagina di un PDF in immagine base64 (PNG)
 */
async function pdfToImageBase64(buffer) {
  try {
    const pdfDoc = await PDFLibDocument.load(buffer);
    const page = pdfDoc.getPage(0);
    const { width, height } = page.getSize();
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");

    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);

    await page.render({
      canvasContext: context,
      viewport: page.getViewport({ scale: 2 }),
    }).promise;

    return canvas.toDataURL("image/png").split(",")[1];
  } catch (err) {
    console.warn("Conversione PDF → immagine fallita:", err.message);
    return null;
  }
}

dotenv.config();
const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json());

// Serve la pagina principale
app.get("/", (req, res) => {
  res.sendFile("ultracheck.html", { root: "." });
});

// Upload temporaneo
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  }),
});

// Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Normalizza simboli Success/Warning/Failed
function normalizeAnalysis(md) {
  function statusFor(line) {
    const low = line.toLowerCase();
    if (/(^|\s)(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)(\W|$)/.test(low)) return "Failed";
    if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low)) return "Warning";
    if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low)) return "Success";
    return null;
  }
  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const looksLikeField =
        /^[SuccessWarningFailed]/.test(trimmed) ||
        /^[-*]\s*\*\*/.test(trimmed) ||
        /^[-*]\s*[A-ZÀ-Úa-zà-ú]/.test(trimmed);
      if (!looksLikeField) return raw;
      const wanted = statusFor(trimmed);
      if (!wanted) return raw;
      const noMarker = trimmed.replace(/^[SuccessWarningFailed]\s*/, "");
      const leftPad = raw.slice(0, raw.indexOf(trimmed));
      return `${leftPad}${wanted} ${noMarker}`;
    })
    .join("\n");
}

// Helper PDF (pdftotext CLI su Render)
import { spawn } from "child_process";
import os from "os";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let pdfParse;
try {
  const lib = require("pdf-parse");
  pdfParse = lib.default || lib;
  if (typeof pdfParse !== "function") pdfParse = null;
} catch (err) {
  console.log("pdf-parse non disponibile, uso pdftotext CLI");
  pdfParse = null;
}

/**
 * Estrae testo da un PDF.
 * Priorità: pdf-parse → pdftotext CLI
 */
async function parsePdf(buffer) {
  if (pdfParse && typeof pdfParse === "function") {
    try {
      console.log("Estrazione testo con pdf-parse...");
      const data = await pdfParse(buffer);
      return data;
    } catch (err) {
      console.warn("pdf-parse fallito, passo a pdftotext:", err.message);
    }
  }

  console.log("Estrazione testo con pdftotext CLI...");
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `upload-${Date.now()}.pdf`);
  const txtPath = pdfPath.replace(".pdf", ".txt");

  try {
    fs.writeFileSync(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftotext", ["-layout", pdfPath, txtPath]);
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`pdftotext exited with code ${code}`));
        resolve();
      });
      proc.on("error", reject);
    });

    const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8") : "";
    [pdfPath, txtPath].forEach(p => {
      try { fs.unlinkSync(p); } catch {}
    });
    return { text };
  } catch (err) {
    [pdfPath, txtPath].forEach(p => {
      try { fs.unlinkSync(p); } catch {}
    });
    throw new Error("Impossibile estrarre testo dal PDF: " + err.message);
  }
}

// Endpoint analisi
app.post("/analyze", upload.single("label"), async (req, res) => {
  console.log("Endpoint /analyze chiamato");
  console.log("Lingua ricevuta:", req.body.lang);

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nessun file ricevuto." });
    }

    const { azienda, nome, email, telefono, lang } = req.body || {};
    const language = lang || "it";
    console.log(`Lingua selezionata: ${language}`);

    // Variabili di stato
    let base64Data;
    let contentType;
    let extractedText = "";
    let isTextExtracted = false;

    // GESTIONE PDF
    if (req.file.mimetype === "application/pdf") {
      console.log("Rilevato PDF — estraggo testo...");
      try {
        const pdfBuffer = fs.readFileSync(req.file.path);
        const pdfData = await parsePdf(pdfBuffer);
        extractedText = pdfData.text || "";

        if (extractedText.trim()) {
          isTextExtracted = true;
          base64Data = Buffer.from(extractedText).toString("base64");
          contentType = "text/plain";
          console.log("Testo estratto (prime 200 char):", extractedText.substring(0, 200));
        }
      } catch (err) {
        console.warn("Estrazione testo fallita:", err.message);
      }

      // Fallback: converti in immagine se non c'è testo
      if (!isTextExtracted) {
        console.log("Nessun testo estratto → converto PDF in immagine");
        const imageBase64 = await pdfToImageBase64(fs.readFileSync(req.file.path));
        if (imageBase64) {
          base64Data = imageBase64;
          contentType = "image/png";
          console.log("PDF convertito in immagine (PNG)");
        } else {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({
            error: "Impossibile analizzare il PDF: né testo né immagine estraibile."
          });
        }
      }
    }
    // GESTIONE IMMAGINE
    else {
      const imageBytes = fs.readFileSync(req.file.path);
      base64Data = imageBytes.toString("base64");
      contentType = req.file.mimetype;
    }

    // Analisi AI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come un ispettore tecnico *UltraCheck AI* specializzato nella conformità legale delle etichette vino.
Analizza SOLO le informazioni obbligatorie secondo il **Regolamento (UE) 2021/2117**.
Non inventare mai dati visivi: se qualcosa non è leggibile, scrivi "non verificabile".
Rispondi sempre nel formato markdown esatto qui sotto, in lingua: ${language}.
Se c'è anche 1 solo campo Failed mancante, la valutazione finale sarà non conforme.
===============================
### Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (Success conforme / Warning parziale / Failed mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (Success/Warning/Failed) + testo
Volume nominale: (Success/Warning/Failed) + testo
Titolo alcolometrico: (Success/Warning/Failed) + testo
Indicazione allergeni: (Success/Warning/Failed) + testo
Lotto: (Success/Warning/Failed) + testo
QR code: (Success/Warning/Failed) + testo
Lingua corretta per il mercato UE: (Success/Warning/Failed) + testo
Altezza minima dei caratteri: (Success/Warning/Failed) + testo
Contrasto testo/sfondo adeguato: (Success/Warning/Failed) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================`
        },
        {
          role: "system",
          content: `IMPORTANT: se la lingua selezionata è francese (${language}), traduci completamente tutti i titoli e le intestazioni in francese, mantenendo il formato identico.
Francese → "Conformité réglementaire", "Dénomination d’origine", ecc.
Inglese → "Regulatory compliance", "Designation of origin", ecc.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analizza questa etichetta di vino e rispondi interamente in ${language}. Non mescolare l'italiano.`,
            },
            ...(isTextExtracted
              ? [{ type: "text", text: extractedText }]
              : [{
                  type: "image_url",
                  image_url: { url: `data:${contentType};base64,${base64Data}` }
                }]
            ),
          ],
        },
      ],
    });

    const raw = response.choices[0].message.content || "Nessuna risposta ricevuta dall'AI.";
    const analysis = normalizeAnalysis(raw);
    console.log("Analisi completata");

    // Invio email
    if (process.env.SMTP_PASS && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SMTP_PASS);
      const msg = {
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it",
        subject: `Nuova analisi etichetta vino - ${azienda || "azienda non indicata"}`,
        text: `Azienda: ${azienda || "non indicata"}
Nome: ${nome || "non indicato"}
Email: ${email || "non indicata"}
Telefono: ${telefono || "non indicato"}
RISULTATO ANALISI:
${analysis}`,
        attachments: [
          {
            content: fs.readFileSync(req.file.path).toString("base64"),
            filename: req.file.originalname,
            type: req.file.mimetype,
            disposition: "attachment",
          },
        ],
      };
      await sgMail.send(msg);
      console.log("Email inviata via SendGrid");
    }

    fs.unlinkSync(req.file.path);
    res.json({ result: analysis });
  } catch (error) {
    console.error("Errore /analyze:", error.response?.data || error.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: "Errore durante l'elaborazione." });
  }
});

// Avvio server
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck AI attivo su porta ${port}`);
});
