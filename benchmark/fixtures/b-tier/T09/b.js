'use strict';
const fs = require('fs');

function loadIfExists(path) {
  if (fs.existsSync(path)) {
    return fs.readFileSync(path, 'utf8');
  }
  return null;
}

module.exports = { loadIfExists };
