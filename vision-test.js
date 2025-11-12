import vision from '@google-cloud/vision';

// Crea il client indicando esplicitamente il file JSON
const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

async function run() {
  try {
    const [result] = await client.textDetection('etichetta-prova.png');
    console.log('✅ Vision OCR funzionante!');
    console.log(result.textAnnotations[0]?.description || 'Nessun testo trovato.');
  } catch (err) {
    console.error('❌ Errore Vision:', err.message);
  }
}

run();
