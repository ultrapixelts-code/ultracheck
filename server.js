import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";


dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
app.use(express.static("."));
app.use(express.json());

// Serve la pagina principale
app.get("/", (req, res) => {
  res.sendFile("ultracheck.html", { root: "." });
});

// 📂 Upload temporaneo dei file
const upload = multer({ dest: "uploads/" });

// 🔑 Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🧩 Funzione per normalizzare i simboli
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

// 📤 Endpoint analisi etichetta
app.post("/analyze", upload.single("label"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nessun file ricevuto." });

    console.log(`📥 Ricevuto: ${req.file.originalname} (${req.file.mimetype}, ${(req.file.size / 1024).toFixed(1)} KB)`);

    const imageBytes = fs.readFileSync(req.file.path);
    const base64Image = imageBytes.toString("base64");

    // 🧠 Analisi AI
 const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  temperature: 0.1, // 🔒 quasi deterministico
  seed: 42, // 🔁 per risultati sempre uguali
  messages: [
    {
      role: "system",
      content: `Agisci come un ispettore tecnico *UltraCheck AI* specializzato nella conformità legale delle etichette vino.
Analizza SOLO le informazioni obbligatorie secondo il **Regolamento (UE) 2021/2117**.
Non inventare mai dati visivi: se qualcosa non è leggibile, scrivi "non verificabile".
Rispondi sempre nel formato markdown esatto qui sotto, in lingua: ${req.body.lang || "it"}.

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
Altezza minima dei caratteri: (✅/⚠️/❌) + testo
Contrasto testo/sfondo adeguato: (✅/⚠️/❌) + testo


**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================

Tieni la valutazione coerente con la presenza o assenza reale dei campi.`
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Analizza questa etichetta di vino e valuta solo la conformità legale, senza interpretazioni grafiche."
        },
        {
          type: "image_url",
          image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` }
        }
      ]
    }
  ]
});

    const raw = response.choices[0].message.content || "Nessuna risposta ricevuta dall'AI.";
    const analysis = normalizeAnalysis(raw); // 🔧 Normalizza simboli incoerenti
    console.log("✅ Analisi completata");

    // 🔹 Dati del form
    const { azienda, nome, email, telefono } = req.body || {};

    // 📧 Invio email
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const mailOptions = {
        from: `"UltraCheck AI" <${process.env.SMTP_USER}>`,
        to: process.env.MAIL_TO || process.env.SMTP_USER,
        subject: `🧠 Nuova analisi etichetta vino - ${azienda || "azienda non indicata"}`,
        text: `
Azienda: ${azienda || "non indicata"}
Nome: ${nome || "non indicato"}
Email: ${email || "non indicata"}
Telefono: ${telefono || "non indicato"}

📊 RISULTATO ANALISI:
${analysis}
        `,
        attachments: [
          {
            filename: req.file.originalname,
            path: req.file.path,
            contentType: req.file.mimetype,
          },
        ],
      };

      await transporter.sendMail(mailOptions);
      console.log("📧 Email inviata con allegato");
    }

    fs.unlinkSync(req.file.path); // elimina file temporaneo

    res.json({ result: analysis });
  } catch (error) {
    console.error("💥 Errore /analyze:", error.response?.data || error.message);
    res.status(500).json({ error: "Errore durante l'elaborazione o l'invio email." });
  }
});

// 🟢 Avvio server (compatibile con Render)
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ UltraCheck AI attivo su porta ${PORT}`);
});

