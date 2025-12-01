// ocr.js
import Tesseract from "tesseract.js";

/**
 * OCR con Google Vision
 * @param {Buffer} buffer 
 * @param {Object|null} visionClient 
 * @returns Testo estratto o stringa vuota
 */
export async function ocrGoogle(buffer, visionClient) {
  if (!visionClient) return "";

  try {
    const [result] = await visionClient.textDetection({
      image: { content: buffer }
    });

    const text = result.fullTextAnnotation?.text || "";

    if (text.trim()) console.log("Google Vision OCR: OK");
    return text;
  } catch (err) {
    console.warn("Google Vision errore:", err.message);
    return "";
  }
}

/**
 * OCR fallback con Tesseract
 * @param {*} buffer 
 * @returns testo estratto o stringa vuota
 */
export async function ocrFallback(buffer) {
  console.log("Google Vision fallito → Tesseract (hrv+eng+ita)");

  const { data: { text } } = await Tesseract.recognize(buffer, "hrv+eng+ita");

  return text || "";
}
