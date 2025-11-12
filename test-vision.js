import vision from '@google-cloud/vision';
import fs from 'fs';

console.log('Credenziali:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
console.log('File trovato:', fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS));

const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

async function testVision() {
  try {
    const [result] = await client.textDetection('./EA252774-0386-4E7E-8903-BFCFFECA4E9E.jpeg');
    const detections = result.textAnnotations;
    console.log('✅ Test riuscito!');
    console.log(detections[0]?.description || 'Nessun testo trovato');
  } catch (error) {
    console.error('❌ Vision errore:', error);
  }
}

testVision();
