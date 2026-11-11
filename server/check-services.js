import { createMailService } from './mail.js';
import { createSheetsService } from './sheets.js';

const mail = createMailService();
const sheets = createSheetsService();
const [emailResult, sheetResult] = await Promise.all([mail.verifyConnection(), sheets.verifyConnection()]);
console.log('Verification email service:', emailResult.ok ? 'connected' : emailResult.code);
console.log('Customer sheet:', sheetResult.ok ? 'connected and restricted' : sheetResult.code);
mail.close();
if (!emailResult.ok || !sheetResult.ok) process.exitCode = 1;
