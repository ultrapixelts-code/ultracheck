import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json());

// Serve la pagina principale
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "." });
});

// Upload temporaneo
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  }),
});

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Normalizza simboli
function normalizeAnalysis(md) {
  const hasStatus = (s) => /^[✅⚠️❌]/.test(s.trimStart());
  function statusFor(line) {
    const low = line.toLowerCase();
    if (/(^|\s)(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)(\W|$)/.test(low)) return "❌";
    if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low)) return "⚠️";
    if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low)) return "✅";
    return null;
  }
  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const looksLikeField =
        /^[✅⚠️❌]/.test(trimmed) ||
        /^[-*]\s*\*\*/.test(trimmed) ||
        /^[-*]\s*[A-ZÀ-Úa-zà-ú]/.test(trimmed);
      if (!looksLikeField) return raw;
      const wanted = statusFor(trimmed);
      if (!wanted) return raw;
      const noMarker = trimmed.replace(/^[✅⚠️❌]\s*/, "");
      const leftPad = raw.slice(0, raw.indexOf(trimmed));
      return leftPad + `${wanted} ${noMarker}`;
    })
    .join("\n");
}

// Lettura PDF
async function parsePdf(buffer) {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    if (typeof pdfParse !== 'function') throw new Error('pdf-parse non è una funzione');
    return await pdfParse(buffer);
  } catch (err) {
    console.error("Errore pdf-parse:", err.message);
    return { text: "[Errore: testo non estraibile dal PDF]" };
  }
}

// === ENDPOINT ANALISI ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  console.log("Endpoint /analyze chiamato");
  try {
    if (!req.file) return res.status(400).json({ error: "Nessun file." });

    const { azienda, nome, email, telefono, lang } = req.body || {};
    const language = lang || "it";
    console.log(`Lingua: ${language}`);

    let base64Image;
    let isPdf = false;

    if (req.file.mimetype === "application/pdf") {
      console.log("Rilevato PDF → estrazione testo...");
      isPdf = true;
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await parsePdf(pdfBuffer);
      base64Image = Buffer.from(pdfData.text).toString("base64");
    } else {
      base64Image = fs.readFileSync(req.file.path).toString("base64");
    }

    // === ANALISI AI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
 ambienti: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come ispettore UltraCheck AI. Analizza SOLO i campi obbligatori del Reg. UE 2021/2117.
Rispondi in ${language} con formato markdown esatto. Se un campo manca → ❌ e valutazione finale = Non conforme.
===============================
### 🔎 Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (✅/⚠️/❌) + testo
Nome e indirizzo del produttore o imbottigliatore: (✅/⚠️/❌) + testo
Volume nominale: (✅/⚠️/❌) + testo
Titolo alcolometrico: (✅/⚠️/❌) + testo
Indicazione allergeni: (✅/⚠️/❌) + testo
Lotto: (✅/⚠️/❌) + testo
QR code: (✅/⚠️/❌) + testo
Lingua corretta per il mercato UE: (✅/⚠️/❌) + testo
Altezza minima dei caratteri: (✅/⚠️/❌) + testo
Contrasto testo/sfondo adeguato: (✅/⚠️/❌) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================`
        },
        {
          role: "system",
          content: `Se ${language === 'fr' ? 'francese' : language === 'en' ? 'inglese' : 'italiano'}, traduci TUTTO il report in quella lingua.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Analizza l'etichetta e rispondi in ${language}.` },
            { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` } }
          ]
        }
      ]
    });

    const raw = response.choices[0].message.content || "";
    const analysis = normalizeAnalysis(raw);
    console.log("Analisi completata");

    // === GENERA PDF REPORT ===
    const reportFilename = `report-${Date.now()}.pdf`;
    const reportPath = `/tmp/${reportFilename}`;
    const doc = new PDFDocument({ margin: 50 });
    const writeStream = fs.createWriteStream(reportPath);
    doc.pipe(writeStream);

    doc.fontSize(18).text("UltraCheck AI - Report", { align: "center" });
    doc.moveDown(1.5);
    doc.fontSize(12);

    analysis.split("\n").forEach(line => {
      if (!line.trim()) {
        doc.moveDown(0.5);
      } else if (line.startsWith("### ")) {
        doc.fontSize(14).text(line.replace("### ", ""), { underline: true });
        doc.moveDown(0.5);
      } else if (line.includes("Valutazione finale")) {
        const color = line.includes("Non conforme") ? "#a94442" :
                     line.includes("Parzialmente") ? "#b77f00" : "#3c763d";
        doc.fontSize(15).fillColor(color).text(line, { bold: true });
      } else if (/^[✅⚠️❌]/.test(line.trimStart())) {
        const icon = line.trimStart().charAt(0);
        const text = line.replace(/^[✅⚠️❌]\s*/, "");
        doc.text(`${icon} ${text}`);
      } else {
        doc.text(line);
      }
      doc.moveDown(0.3);
    });

    doc.end();
    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // === INVIO EMAIL ===
    if (process.env.SMTP_PASS && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SMTP_PASS);
      await sgMail.send({
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it",
        subject: `Nuova analisi - ${azienda || "Sconosciuta"}`,
        text: `Da: ${nome} (${email})\n\n${analysis}`,
        attachments: [
          { content: fs.readFileSync(req.file.path).toString("base64"), filename: req.file.originalname, type: req.file.mimetype, disposition: "attachment" },
          { content: fs.readFileSync(reportPath).toString("base64"), filename: "UltraCheck_Report.pdf", type: "application/pdf", disposition: "attachment" }
        ]
      });
    }

    // === PULIZIA ===
    fs.unlinkSync(req.file.path); // solo il file originale

    // === RISPOSTA ===
    res.json({
      result: analysis,
      reportUrl: `/ultracheck.html?report=${reportFilename}&lang=${language}`
    });

  } catch (error) {
    console.error("Errore /analyze:", error.message);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Errore server." });
  }
});

// === SERVI PDF ===
app.get("/report/:filename", (req, res) => {
  const filePath = `/tmp/${req.params.filename}`;
  if (fs.existsSync(filePath)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=report.pdf");
    res.sendFile(filePath, { root: "/" });
  } else {
    res.status(404).send("Report non trovato.");
  }
});

// === ultracheck.html DINAMICA ===
app.get("/ultracheck.html", (req, res) => {
  const { report, lang = "it" } = req.query;
  const reportUrl = report ? `/report/${report}` : null;

  const titles = { it: "Report Analisi", fr: "Rapport d’analyse", en: "Analysis Report" };
  const msgs = { it: "Il tuo report è pronto", fr: "Votre rapport est prêt", en: "Your report is ready" };

  res.send(`
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>UltraCheck AI - ${titles[lang]}</title>
  <style>
    body { font-family: Arial; margin: 40px; text-align: center; background: #f9f9f9; }
    h1 { color: #c6a450; }
    .btn { padding: 12px 24px; margin: 10px; background: #111; color: white; text-decoration: none; border-radius: 6px; }
    .btn:hover { background: #c6a450; color: #111; }
    iframe { width: 100%; height: 75vh; border: none; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>UltraCheck AI</h1>
  <p><strong>${msgs[lang]}</strong></p>
  <div>
    <a href="${reportUrl}" download class="btn">Scarica PDF</a>
    <a href="/" class="btn">Nuova Analisi</a>
  </div>
  ${reportUrl ? `<iframe src="${reportUrl}"></iframe>` : "<p>Report non disponibile.</p>"}
</body>
</html>`);
});

// === AVVIO SERVER ===
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck AI attivo su porta ${port}`);
});
