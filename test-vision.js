import fs from "fs";
import { ImageAnnotatorClient } from "@google-cloud/vision";

const client = new ImageAnnotatorClient({
  keyFilename: "./ultracheck-ocr.json",
});

const file = fs.readFileSync("apres.png");
client
  .textDetection({ image: { content: file } })
  .then(([res]) => {
    console.log("✅ Google Vision funziona:");
    console.log(res.fullTextAnnotation?.text || "(vuoto)");
  })
  .catch((err) => console.error("❌ Vision errore:", err.message));
