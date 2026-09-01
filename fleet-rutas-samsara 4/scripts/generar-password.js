// Genera el hash bcrypt de una contraseña para pegarlo en ADMIN_PASSWORD_HASH del .env
//
// Uso:
//   node scripts/generar-password.js "tu_contraseña_aqui"

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Uso: node scripts/generar-password.js "tu_contraseña"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nCopia esta línea completa en tu .env:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
