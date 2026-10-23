/* Подпись mac-обновления (Ed25519) для самописного апдейтера в main.js.
 * Сборка неподписана Developer ID, поэтому sha512 из latest-mac.yml доказывает
 * только целостность: подменивший релиз подменил бы и манифест. Подпись
 * делается ключом из секрета CI, публичная половина вшита в приложение.
 *
 * Запуск: UPDATE_SIGNING_KEY="<pem>" node build/sign-update.js dist/*.zip
 * Рядом с каждым zip кладёт <zip>.sig (base64). */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pem = String(process.env.UPDATE_SIGNING_KEY || '').trim();
if (!pem) {
  console.error('[sign-update] UPDATE_SIGNING_KEY не задан — без подписи mac-клиенты откажутся ставить обновление');
  process.exit(1);
}
const files = process.argv.slice(2).filter((f) => f.toLowerCase().endsWith('.zip'));
if (!files.length) {
  console.error('[sign-update] нет zip для подписи');
  process.exit(1);
}
const key = crypto.createPrivateKey(pem);
for (const file of files) {
  const digest = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  // Тот же формат сообщения, что проверяет verifyMacUpdateSignature в main.js
  const message = Buffer.from(`OmniDeck-update\n${path.basename(file)}\n${digest}`);
  fs.writeFileSync(`${file}.sig`, crypto.sign(null, message, key).toString('base64'));
  console.log(`[sign-update] ${path.basename(file)}.sig`);
}
