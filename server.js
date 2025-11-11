import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import PDFDocument from "pdfkit";
import cors from "cors";
import pdfParse from "pdf-parse";  // Import statico

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.static("."));
app.use(express.json());

// Serve homepage
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "." });
});

// Upload
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
  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const low = trimmed.toLowerCase();
      let status = null;
      if (/(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)/.test(low)) status = "❌";
      else if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low)) status = "⚠️";
      else if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low)) status = "✅";
      if (status && !/^[✅⚠️❌]/.test(trimmed)) {
        const noMarker = trimmed.replace(/^[✅⚠️❌]\s*/, "");
        const leftPad = raw.slice(0, raw.indexOf(trimmed));
        return leftPad + `${status} ${noMarker}`;
      }
      return raw;
    })
    .join("\n");
}

// === ANALISI ETICHETTA ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  console.log("✅ Endpoint /analyze chiamato");
  try {
    if (!req.file) return res.status(400).json({ error: "Nessun file." });

    const { azienda, nome, email, telefono, lang } = req.body;
    const language = lang || "it";
    console.log(`🌍 Lingua: ${language}`);

    let base64Image = null;
    let extractedText = "";

    if (req.file.mimetype === "application/pdf") {
      console.log("📄 PDF rilevato → estrazione testo...");
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(pdfBuffer);
      extractedText = pdfData.text || "";
    } else {
      console.log("🖼️ Immagine rilevata");
      base64Image = fs.readFileSync(req.file.path).toString("base64");
    }

    // === ANALISI OPENAI ===
    const messages = [
      {
        role: "system",
        content: `Agisci come ispettore UltraCheck AI per etichette vino (Reg. UE 2021/2117).
Rispondi in ${language} con formato markdown esatto. Se manca un campo → ❌ e finale "Non conforme".
### 🔎 Conformità normativa
Denominazione di origine: (✅/⚠️/❌) + testo
Nome e indirizzo produttore: (✅/⚠️/❌) + testo
Volume nominale: (✅/⚠️/❌) + testo
Titolo alcolometrico: (✅/⚠️/❌) + testo
Allergeni: (✅/⚠️/❌) + testo
Lotto: (✅/⚠️/❌) + testo
QR code: (✅/⚠️/❌) + testo
Lingua UE: (✅/⚠️/❌) + testo
Altezza caratteri: (✅/⚠️/❌) + testo
Contrasto: (✅/⚠️/❌) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme`
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Testo estratto dal PDF (se presente): ${extractedText}\n\nAnalizza l'etichetta in ${language}. Non mescolare lingue.`
          }
        ]
      }
    ];

    if (base64Image) {
      messages[1].content.push({
        type: "image_url",
        image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` }
      });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages
    });

    const raw = response.choices[0].message.content || "";
    const analysis = normalizeAnalysis(raw);
    console.log("✅ Analisi completata");

    // === GENERA PDF REPORT ===
    const reportFilename = `report-${Date.now()}.pdf`;
    const reportPath = `/tmp/${reportFilename}`;
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(reportPath);
    doc.pipe(stream);

    doc.fontSize(18).text("UltraCheck AI - Report", { align: "center" });
    doc.moveDown(1.5);
    doc.fontSize(12).text(analysis);

    doc.end();
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);  // FIX: Rimosso la virgola extra
    });

    // === EMAIL ===
    if (process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it",
        subject: `Analisi etichetta - ${azienda || "N/D"}`,
        text: `${analysis}\n\nDa: ${nome} (${email})`,
        attachments: [
          { content: fs.readFileSync(req.file.path).toString("base64"), filename: req.file.originalname, type: req.file.mimetype, disposition: "attachment" },
          { content: fs.readFileSync(reportPath).toString("base64"), filename: "UltraCheck_Report.pdf", type: "application/pdf", disposition: "attachment" }
        ]
      });
      console.log("📧 Email inviata");
    }

    fs.unlinkSync(req.file.path);

    res.json({
      result: analysis,
      reportUrl: `/ultracheck.html?report=${reportFilename}&lang=${language}`
    });

  } catch (error) {
    console.error("💥 Errore /analyze:", error.message);
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Errore server: " + error.message });
  }
});

// === SERVI PDF ===
app.get("/report/:filename", (req, res) => {
  const path = `/tmp/${req.params.filename}`;
  if (fs.existsSync(path)) {
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", "inline; filename=report.pdf");
    res.sendFile(path);
  } else {
    res.status(404).send("Report non trovato.");
  }
});

// === ultracheck.html ===
app.get("/ultracheck.html", (req, res) => {
  const { report, lang = "it" } = req.query;
  const reportUrl = report ? `/report/${report}` : null;

  const titles = { it: "Report Analisi", fr: "Rapport d'Analyse", en: "Analysis Report" };
  const msgs = { it: "Il tuo report è pronto!", fr: "Votre rapport est prêt!", en: "Your report is ready!" };

  let html = `
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>UltraCheck AI - ${titles[lang]}</title>
  <style>
    body { font-family: Arial; margin: 40px; text-align: center; background: #f9f9f9; }
    h1 { color: #c6a450; }
    .btn { padding: 12px 24px; margin: 10px; background: #111; color: white; text-decoration: none; border-radius: 6px; }
    .btn:hover { background: #c6a450; color: #111; }
    iframe { width: 100%; height: 75vh; border: none; margin-top: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .error { color: red; }
  </style>
</head>
<body>
  <h1>UltraCheck AI</h1>
  <p><strong>${msgs[lang]}</strong></p>
  <div>
    ${reportUrl ? `<a href="${reportUrl}" download class="btn">📥 Scarica PDF</a>` : '<p class="error">Nessun report disponibile. Torna alla <a href="/">home</a> e riprova.</p>'}
    <a href="/" class="btn">🔄 Nuova Analisi</a>
  </div>
  ${reportUrl ? `<iframe src="${reportUrl}"></iframe>` : ""}
</body>
</html>`;
  res.send(html);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ UltraCheck AI su porta ${port}`);
});
