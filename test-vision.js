import 'dotenv/config';
import vision from '@google-cloud/vision';

const client = new vision.ImageAnnotatorClient();

async function main() {
  try {
    const [result] = await client.textDetection('/workspaces/ultracheck/etichetta-prova.png');
    console.log('✅ OCR riuscito:', result.textAnnotations[0].description);
  } catch (err) {
    console.error('❌ Vision errore:', err.message);
  }
}

main();
