// Prints a short hash of the app's dependencies so the shared cache can reuse node_modules across app versions.
const p = require('../package.json');
console.log(require('crypto').createHash('sha256').update(JSON.stringify([p.dependencies, process.version])).digest('hex').slice(0, 12));
