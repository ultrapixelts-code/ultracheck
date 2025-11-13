Skip to content
Navigation Menu
ultrapixelts-code
ultracheck

Type / to search
Code
Issues
Pull requests
Actions
Projects
Wiki
Security
3
Insights
Settings
Commit 7050ccc
ultrapixelts-code
ultrapixelts-code
authored
2 minutes ago
·
·
Verified
Update server.js
main
1 parent 
2b3b95a
 commit 
7050ccc
File tree
Filter files…
server.js
1 file changed
+106
-96
lines changed
Search within code
 
‎server.js‎
+106
-96
Lines changed: 106 additions & 96 deletions
Original file line number	Diff line number	Diff line change
@@ -25,7 +25,6 @@ if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    console.log("Google Vision: configurato da JSON env");
  } catch (err) {
    console.error("Google Vision: JSON non valido →", err.message);
    console.error("Controlla GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
} else {
  console.warn("Google Vision: GOOGLE_APPLICATION_CREDENTIALS_JSON non impostata → OCR disabilitato");
@@ -35,16 +34,14 @@ if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
const app = express();
const port = process.env.PORT || 8080;

// Serve TUTTI i file statici dalla root (main/)
app.use(express.static("."));  // index.html, ultracheck.html, ecc.
app.use(express.static(".")); // index.html, ultracheck.html, ecc.
app.use(express.json());

// Homepage → index.html
// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// Rotta per ultracheck.html (opzionale)
app.get("/ultracheck", (req, res) => {
  res.sendFile(path.join(process.cwd(), "ultracheck.html"));
});
@@ -62,7 +59,7 @@ const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === UTILITY ===
// === UTILITY: normalizza Success/Warning/Failed ===
function normalizeAnalysis(md) {
  const statusFor = (line) => {
    const low = line.toLowerCase();
@@ -179,7 +176,11 @@ app.post("/analyze", upload.single("label"), async (req, res) => {
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;
  const language = lang.toLowerCase();
  // === NORMALIZZA E VALIDA LINGUA ===
  const language = ["it", "en", "fr"].includes(lang.toLowerCase().trim())
    ? lang.toLowerCase().trim()
    : "it";

  let fileBuffer = null;
  let extractedText = "";
@@ -211,7 +212,6 @@ app.post("/analyze", upload.single("label"), async (req, res) => {
          isTextExtracted = extractedText.trim().length > 30;
        }
      }
      if (!isTextExtracted) throw new Error("Nessun testo leggibile nel PDF");

      extractedText = extractedText
@@ -221,7 +221,6 @@ app.post("/analyze", upload.single("label"), async (req, res) => {
        .replace(/\r\n/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
@@ -231,111 +230,104 @@ app.post("/analyze", upload.single("label"), async (req, res) => {
      ? [{ type: "text", text: extractedText }]
      : [{ type: "image_url", image_url: { url: `data:${contentType};base64,${base64Data}` } }];

  const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  temperature: 0.1,
  seed: 42,
  messages: [
    {
      role: "system",
      content: `Agisci come un ispettore tecnico *UltraCheck AI* specializzato nella conformità legale delle etichette vino.
    // === OPENAI CALL ===
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
### Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (conforme / parziale / mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (/parziale/) + testo
Volume nominale: (/parziale/) + testo
Titolo alcolometrico: (/parziale/) + testo
Indicazione allergeni: (/parziale/) + testo
Lotto: (/parziale/) + testo
QR code o link ingredienti/energia: (/parziale/) + testo
Lingua corretta per il mercato UE: (/parziale/) + testo
Altezza minima dei caratteri: (/parziale/) + testo
Contrasto testo/sfondo adeguato: (/parziale/) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================`
    },
    {
      role: "system",
      content: `IMPORTANT: Se la lingua selezionata è francese (${language} = "fr"), traduci completamente tutti i titoli e le intestazioni in francese, mantenendo il formato identico.
Se è inglese (${language} = "en"), traduci in inglese.
Esempi di traduzione:
🇫🇷 **Francese**
- "Conformità normativa" → "Conformité réglementaire"
- "Denominazione di origine" → "Dénomination d’origine"
- "Nome e indirizzo del produttore o imbottigliatore" → "Nom et adresse du producteur ou de l’embouteilleur"
- "Volume nominale" → "Volume nominal"
- "Titolo alcolometrico" → "Titre alcoométrique"
- "Indicazione allergeni" → "Indication des allergènes"
- "Lotto" → "Lot"
- "QR code o link ingredienti/energia" → "QR code ou lien ingrédients/énergie"
- "Lingua corretta per il mercato UE" → "Langue correcte pour le marché UE"
- "Altezza minima dei caratteri" → "Hauteur minimale des caractères"
- "Contrasto testo/sfondo adeguato" → "Contraste texte/fond adéquat"
- "Valutazione finale" → "Évaluation finale"
- "Conforme" → "Conforme"
- "Parzialmente conforme" → "Partiellement conforme"
- "Non conforme" → "Non conforme"
🇬🇧 **Inglese**
- "Conformità normativa" → "Regulatory compliance"
- "Denominazione di origine" → "Designation of origin"
- "Nome e indirizzo del produttore o imbottigliatore" → "Producer or bottler name and address"
- "Volume nominale" → "Nominal volume"
- "Titolo alcolometrico" → "Alcohol by volume"
- "Indicazione allergeni" → "Allergen indication"
- "Lotto" → "Batch code"
- "QR code o link ingredienti/energia" → "QR code or link to ingredients/energy"
- "Lingua corretta per il mercato UE" → "Correct language for EU market"
- "Altezza minima dei caratteri" → "Minimum character height"
- "Contrasto testo/sfondo adeguato" → "Adequate text/background contrast"
- "Valutazione finale" → "Final assessment"
- "Conforme" → "Compliant"
- "Parzialmente conforme" → "Partially compliant"
- "Non conforme" → "Non-compliant"
Non usare parole italiane in nessun caso. Tutto il testo deve essere nella lingua selezionata, inclusi i titoli, i campi e le opzioni di valutazione.`
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Analizza questa etichetta di vino in ${language}. Fornisci il report nel formato richiesto.` },
        ...userContent
        },
        {
          role: "system",
          content: `IMPORTANT: Se la lingua selezionata è francese (${language} === "fr"), traduci TUTTO in francese.
Se è inglese (${language} === "en"), traduci TUTTO in inglese.
Mantieni ESATTAMENTE il formato con emoji e markdown.
Esempi di traduzione completi:
FRANCESE (fr):
### Conformité réglementaire (Règ. UE 2021/2117)
Dénomination d’origine: (conforme / partielle / manquante) + texte
...
**Évaluation finale:** Conforme / Partiellement conforme / Non conforme
INGLESE (en):
### Regulatory compliance (Reg. UE 2021/2117)
Designation of origin: (compliant / partial / missing) + text
...
**Final assessment:** Compliant / Partially compliant / Non-compliant
Non mescolare lingue. Usa solo la lingua selezionata.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Analizza questa etichetta di vino in ${language}. Fornisci il report nel formato richiesto.` },
            ...userContent
          ],
        },
      ],
    },
  ],
});
    });

    let analysis = response.choices[0].message.content || "Nessuna risposta dall'IA.";
    analysis = normalizeAnalysis(analysis);

    // === INVIO EMAIL CON SENDGRID (con log completi) ===
    if (fileBuffer && process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
        const msg = {
          to: process.env.MAIL_TO,
          from: "noreply@ultracheck.ai",
          from: "noreply@ultracheck.ai", // VERIFICA SU SENDGRID!
          subject: `UltraCheck: ${azienda || "Analisi etichetta"}`,
          text: `Analisi completata per ${nome || "utente"}\n\n${analysis}`,
          attachments: [{
            content: fileBuffer.toString("base64"),
            filename: req.file.originalname,
            type: req.file.mimetype,
          }],
        });
        console.log("Email inviata a", process.env.MAIL_TO);
          attachments: [
            {
              content: fileBuffer.toString("base64"),
              filename: req.file.originalname,
              type: req.file.mimetype,
              disposition: "attachment",
            },
          ],
        };
        console.log("Tentativo invio email a:", msg.to);
        const response = await sgMail.send(msg);
        console.log("EMAIL INVIATA! Status:", response[0].statusCode);
      } catch (err) {
        console.warn("Email fallita:", err.message);
        console.error("SENDGRID FALLITO:");
        console.error("→ Message:", err.message);
        if (err.response) {
          console.error("→ Status:", err.response.statusCode);
          console.error("→ Body:", JSON.stringify(err.response.body, null, 2));
        }
      }
    }

    res.json({ result: analysis });
  } catch (error) {
    console.error("Errore:", error.message);
    res.status(500).json({ error: "Elaborazione fallita: " + error.message });
@@ -370,12 +362,29 @@ app.get("/test-vision", async (req, res) => {
    res.status(500).send(`
      <h2>Errore Google Vision</h2>
      <pre>${err.message}</pre>
      <p>Controlla:</p>
      <ul>
        <li>API Vision abilitata?</li>
        <li>Service Account con ruolo <code>Cloud Vision API User</code>?</li>
        <li>Chiave JSON completa in <code>GOOGLE_APPLICATION_CREDENTIALS_JSON</code>?</li>
      </ul>
    `);
  }
});
// === TEST EMAIL (usa questo per debug!) ===
app.get("/test-email", async (req, res) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.MAIL_TO) {
    return res.status(500).send("SENDGRID_API_KEY o MAIL_TO mancanti");
  }
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: process.env.MAIL_TO,
      from: "noreply@ultracheck.ai",
      subject: "TEST ULTRACHECK",
      text: "Se ricevi questa, SendGrid funziona!",
    });
    res.send("Email di test inviata! Controlla la casella.");
  } catch (err) {
    res.status(500).send(`
      <h2>Errore SendGrid</h2>
      <pre>${err.message}</pre>
      <pre>${JSON.stringify(err.response?.body, null, 2)}</pre>
    `);
  }
});
@@ -384,4 +393,5 @@ app.get("/test-vision", async (req, res) => {
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck LIVE su http://0.0.0.0:${port}`);
  console.log(`URL: https://ultracheck.onrender.com`);
  console.log(`Test email: https://ultracheck.onrender.com/test-email`);
});
0 commit comments
Comments
0
 (0)
Comment
You're not receiving notifications from this thread.

Update server.js · ultrapixelts-code/ultracheck@7050ccc
