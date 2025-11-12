import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import { fromBuffer } from "pdf2pic";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import vision from "@google-cloud/vision";

// Inizializza client
const visionClient = new vision.ImageAnnotatorClient();
dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json());

// Serve pagina principale
app.get("/", (req, res) => {
  res.sendFile("ultracheck.html", { root: "." });
});

// Configurazione upload su /tmp (Render-friendly)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === FUNZIONI UTILITY ===

// Normalizza Success/Warning/Failed nel markdown
function normalizeAnalysis(md) {
  const statusFor = (line) => {
    const low = line.toLowerCase();
    if (/(^|\s)(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)(\W|$)/.test(low))
      return "Failed";
    if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low))
      return "Warning";
    if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low))
      return "Success";
    return null;
  };

  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const isFieldLine =
        /^[Success|Warning|Failed]/.test(trimmed) ||
        /^[-*]\s*\*\*[^\*]/.test(trimmed) ||
        /^[-*]\s+[A-ZÀ-Ú]/.test(trimmed);

      if (!isFieldLine) return raw;

      const wanted = statusFor(trimmed);
      if (!wanted) return raw;

      const cleanLine = trimmed.replace(/^(Success|Warning|Failed)\s*/, "");
      const padding = raw.slice(0, raw.indexOf(trimmed));
      return `${padding}${wanted} ${cleanLine}`;
    })
    .join("\n");
}

// Estrae testo da PDF (pdf-parse → pdftotext CLI)
let pdfParse = null;
try {
  const pdfParseLib = await import("pdf-parse");
  pdfParse = pdfParseLib.default || pdfParseLib;
} catch (err) {
  console.log("pdf-parse non disponibile → uso pdftotext CLI");
}

async function parsePdf(buffer) {
  // Prova pdf-parse
  if (pdfParse) {
    try {
      console.log("Estrazione con pdf-parse...");
      const data = await pdfParse(buffer);
      return { text: data.text || "" };
    } catch (err) {
      console.warn("pdf-parse fallito:", err.message);
    }
  }

  // Fallback: pdftotext CLI
  console.log("Estrazione con pdftotext CLI...");
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  const txtPath = pdfPath.replace(".pdf", ".txt");

  try {
    await fs.promises.writeFile(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftotext", ["-raw", "-layout", pdfPath, txtPath]);
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`pdftotext exited with code ${code}`));
        else resolve();
      });
      proc.on("error", reject);
    });

    const text = fs.existsSync(txtPath) ? await fs.promises.readFile(txtPath, "utf8") : "";
    return { text };
  } catch (err) {
    throw new Error("Impossibile estrarre testo dal PDF: " + err.message);
  } finally {
    [pdfPath, txtPath].forEach((p) => {
      fs.unlink(p, () => {});
    });
  }
}

// Converte prima pagina PDF → immagine migliorata per OCR
async function pdfToImageBase64(buffer) {
  try {
    const convert = fromBuffer(buffer, { density: 300, format: "png" });
    const page = await convert(1);
    if (!page?.base64) return null;

    const imageBuffer = Buffer.from(page.base64, "base64");
    const enhanced = await sharp(imageBuffer)
      .resize({ width: 2500, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .threshold(180)
      .sharpen()
      .toBuffer();

    return enhanced.toString("base64");
  } catch (err) {
    console.warn("pdfToImageBase64 fallita:", err.message);
    return null;
  }
}

// OCR con Google Vision
async function ocrGoogle(buffer) {
  try {
    const [result] = await visionClient.textDetection({ image: { content: buffer } });
    const text = result.fullTextAnnotation?.text || "";
    if (text.trim()) {
      console.log("Google OCR estratto:", text.substring(0, 300));
    } else {
      console.warn("Google OCR: nessun testo trovato");
    }
    return text;
  } catch (err) {
    console.warn("Errore Google OCR:", err.message);
    return "";
  }
}

// === ENDPOINT ANALISI ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) {
    return res.status(400).json({ error: "Nessun file ricevuto." });
  }

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;
  const language = lang.toLowerCase();

  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";

  try {
    const fileBuffer = await fs.promises.readFile(filePath);

    // === CASO: PDF ===
    if (req.file.mimetype === "application/pdf") {
      console.log("Rilevato PDF → estrazione testo...");

      // 1. Estrai testo nativo
      try {
        const { text } = await parsePdf(fileBuffer);
        if (text.trim().length > 30) {
          extractedText = text;
          isTextExtracted = true;
          console.log("Testo nativo estratto (prime 200):", text.substring(0, 200));
        }
      } catch (err) {
        console.warn("Estrazione nativa fallita:", err.message);
      }

      // 2. Fallback: OCR se testo non estratto
      if (!isTextExtracted) {
        console.log("Fallback OCR su immagine PDF...");
        const imageBase64 = await pdfToImageBase64(fileBuffer);
        if (!imageBase64) {
          throw new Error("Impossibile convertire PDF in immagine");
        }

        const imageBuffer = Buffer.from(imageBase64, "base64");

        // Google Vision
        const googleText = await ocrGoogle(imageBuffer);
        if (googleText.trim().length > 30) {
          extractedText = googleText;
          isTextExtracted = true;
        } else {
          // Tesseract backup
          console.log("Google non sufficiente → Tesseract...");
          try {
            const { data: { text } } = await Tesseract.recognize(
              imageBuffer,
              "eng+ita+fra+deu",
              {
                tessedit_pageseg_mode: "3",
                tessedit_ocr_engine_mode: "1",
              }
            );
            if (text.trim().length > 30) {
              extractedText = text;
              isTextExtracted = true;
            } else {
              base64Data = imageBase64;
              contentType = "image/png";
            }
          } catch (ocrErr) {
            console.warn("Tesseract fallito:", ocrErr.message);
            base64Data = imageBase64;
            contentType = "image/png";
          }
        }
      }

      // Normalizza unità comuni
      if (isTextExtracted) {
        extractedText = extractedText
          .replace(/m\s*l/gi, "ml")
          .replace(/c\s*l/gi, "cl")
          .replace(/%[\s]*v[\s]*ol/gi, "% vol");
      }
    }
    // === CASO: IMMAGINE ===
    else {
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
    }

    // Prepara contenuto per GPT
    if (isTextExtracted) {
      base64Data = Buffer.from(extractedText).toString("base64");
      contentType = "text/plain";
    }

    // === CHIAMATA OPENAI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come *UltraCheck AI*, ispettore tecnico specializzato in etichette vino.
Analizza SOLO le informazioni obbligatorie del Regolamento (UE) 2021/2117.
Non inventare dati. Se non leggibile: "non verificabile".
Rispondi in markdown, lingua: ${language}.
Se c'è anche un solo ❌ → "Non conforme".

### Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (conforme / parziale / mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (conforme / parziale / mancante) + testo
Volume nominale: (conforme / parziale / mancante) + testo
Titolo alcolometrico: (conforme / parziale / mancante) + testo
Indicazione allergeni: (conforme / parziale / mancante) + testo
Lotto: (conforme / parziale / mancante) + testo
QR code o link ingredienti/energia: (conforme / parziale / mancante) + testo
Lingua corretta per il mercato UE: (conforme / parziale / mancante) + testo
Altezza minima dei caratteri: (conforme / parziale / mancante) + testo
Contrasto testo/sfondo adeguato: (conforme / parziale / mancante) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme`,
        },
        {
          role: "system",
          content: `Se lingua = "fr", traduci TUTTO in francese. Es:
- "Conformità normativa" → "Conformité réglementaire"
- "Denominazione di origine" → "Dénomination d’origine"
- "Valutazione finale" → "Évaluation finale"

Se "en":
- "Regulatory compliance"
- "Designation of origin"
- "Final assessment"

Non mescolare lingue.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analizza l'etichetta vino. Rispondi in ${language}.`,
            },
            isTextExtracted
              ? { type: "text", text: extractedText }
              : {
                  type: "image_url",
                  image_url: { url: `data:${contentType};base64,${base64Data}` },
                },
          ],
        },
      ],
    });

    const raw = response.choices[0].message.content || "Nessuna risposta AI.";
    const analysis = normalizeAnalysis(raw);

    // === INVIO EMAIL ===
    if (process.env.SMTP_PASS && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SMTP_PASS);
      const msg = {
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it",
        subject: `UltraCheck - ${azienda || "Azienda"}`,
        text: `Azienda: ${azienda || "-"}
Nome: ${nome || "-"}
Email: ${email || "-"}
Telefono: ${telefono || "-"}
\nRISULTATO:\n${analysis}`,
        attachments: [
          {
            content: fileBuffer.toString("base64"),
            filename: req.file.originalname,
            type: req.file.mimetype,
            disposition: "attachment",
          },
        ],
      };
      await sgMail.send(msg);
      console.log("Email inviata");
    }

    res.json({ result: analysis });
  } catch (error) {
    console.error("Errore /analyze:", error.message);
    res.status(500).json({ error: "Errore elaborazione." });
  } finally {
    // Pulizia sicura
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
  }
});

// Avvio server
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck AI attivo su http://0.0.0.0:${port}`);
});
