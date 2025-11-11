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
// 📂 Upload temporaneo (✅ /tmp scrivibile su Render)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  }),
});
// 🔑 Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
// 🧩 Normalizza simboli
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
        /^[-*]\s***/.test(trimmed) ||
        /^[-*]\s*[A-ZÀ-Úa-zà-ú]/.test(trimmed);
      if (!looksLikeField) return raw;
      const wanted = statusFor(trimmed);
      if (!wanted) return raw;
      const noMarker = trimmed.replace(/^[✅⚠️❌]\s*/, "");
      const leftPad = raw.slice(0, raw.indexOf(trimmed));
      return leftPad + ${wanted} ${noMarker};
    })
    .join("\n");
}
// ⚡ Funzione helper per leggere PDF in modo sicuro su Render
async function parsePdf(buffer) {
  const mod = await import("pdf-parse");
  const pdf = mod.default || mod;
  return await pdf(buffer);
}
// 📤 Endpoint analisi etichetta
app.post("/analyze", upload.single("label"), async (req, res) => {
  console.log("✅ Endpoint /analyze chiamato");
  console.log("Lingua ricevuta:", req.body.lang);
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nessun file ricevuto." });
    }
    console.log("📦 Dati ricevuti dal form:", req.body);
    const { azienda, nome, email, telefono, lang } = req.body || {};
    const language = lang || "it";
    console.log(🌍 Lingua selezionata: ${language});
let base64Image;
let isPdf = false;
if (req.file.mimetype === "application/pdf") {
  console.log("📄 Rilevato PDF — estraggo testo con pdf-parse...");
  isPdf = true;
  const pdfBuffer = fs.readFileSync(req.file.path);
const pdfData = await parsePdf(pdfBuffer);
  const extractedText = pdfData.text;
  base64Image = Buffer.from(extractedText).toString("base64");
} else {
  const imageBytes = fs.readFileSync(req.file.path);
  base64Image = imageBytes.toString("base64");
}
    // 🧠 Analisi AI
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
Se c'è anche 1 solo campo ❌ mancante, la valutazione finale sarà non conforme.
### 🔎 Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (✅ conforme / ⚠️ parziale / ❌ mancante) + testo
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
===============================&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}, &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;role: "system", &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;content:IMPORTANT: Se la lingua selezionata è francese (${language}), traduci completamente tutti i titoli e le intestazioni in francese, mantenendo il formato identico.
Esempi di traduzione:
🇫🇷 **Francese**

"Conformità normativa" → "Conformité réglementaire"
"Denominazione di origine" → "Dénomination d’origine"
"Nome e indirizzo del produttore o imbottigliatore" → "Nom et adresse du producteur ou de l’embouteilleur"
"Valutazione finale" → "Évaluation finale"
🇬🇧 **Inglese**
"Conformità normativa" → "Regulatory compliance"
"Denominazione di origine" → "Designation of origin"
"Nome e indirizzo del produttore o imbottigliatore" → "Producer or bottler name and address"
"Valutazione finale" → "Final assessment"
Non usare parole italiane in nessun caso. Tutto il testo deve essere nella lingua selezionata, inclusi i titoli e i campi.}, &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;role: "user", &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;content: [ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;type: "text", &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;text:Analizza questa etichetta di vino e rispondi interamente in ${language}.
Non mescolare l'italiano, traduci completamente ogni campo e intestazione.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}, &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;type: "image_url", &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;image_url: { url:data:${req.file.mimetype};base64,${base64Image}} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;] &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;] &nbsp;&nbsp;&nbsp;&nbsp;}); &nbsp;&nbsp;&nbsp;&nbsp;const raw = response.choices[0].message.content || "Nessuna risposta ricevuta dall'AI."; &nbsp;&nbsp;&nbsp;&nbsp;const analysis = normalizeAnalysis(raw); &nbsp;&nbsp;&nbsp;&nbsp;console.log("Analisi completata"); &nbsp;&nbsp;&nbsp;// 📧 Invio email tramite SendGrid API if (process.env.SMTP_PASS && process.env.MAIL_TO) { &nbsp;&nbsp;sgMail.setApiKey(process.env.SMTP_PASS); &nbsp;&nbsp;const msg = { &nbsp;&nbsp;&nbsp;&nbsp;to: process.env.MAIL_TO, &nbsp;&nbsp;&nbsp;&nbsp;from: "gabriele.russian@ultrapixel.it", // mittente verificato su SendGrid &nbsp;&nbsp;&nbsp;&nbsp;subject:🧠 Nuova analisi etichetta vino - ${azienda || "azienda non indicata"}, &nbsp;&nbsp;&nbsp;&nbsp;text: 
Azienda: ${azienda || "non indicata"}
Nome: ${nome || "non indicato"}
Email: ${email || "non indicata"}
Telefono: ${telefono || "non indicato"}
📊 RISULTATO ANALISI:
${analysis}
        , &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;attachments: [ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;content: fs.readFileSync(req.file.path).toString("base64"), &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;filename: req.file.originalname, &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;type: req.file.mimetype, &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;disposition: "attachment", &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}, &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;], &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}; &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;await sgMail.send(msg); &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;console.log("📧 Email inviata via SendGrid API"); &nbsp;&nbsp;&nbsp;&nbsp;} &nbsp;&nbsp;&nbsp;&nbsp;fs.unlinkSync(req.file.path); &nbsp;&nbsp;&nbsp;&nbsp;res.json({ result: analysis }); &nbsp;&nbsp;} catch (error) { &nbsp;&nbsp;&nbsp;&nbsp;console.error("💥 Errore /analyze:", error.response?.data || error.message); &nbsp;&nbsp;&nbsp;&nbsp;res.status(500).json({ error: "Errore durante l'elaborazione o l'invio email." }); &nbsp;&nbsp;} }); // 👈 MANCAVA QUESTA PARENTESI // 🟢 Avvio server app.listen(port, "0.0.0.0", () => { &nbsp;&nbsp;console.log(✅ UltraCheck AI attivo su porta ${port}`);
});
