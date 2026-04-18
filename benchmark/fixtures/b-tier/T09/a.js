'use strict';
const fs = require('fs');

function checkConfig(path) {
  if (fs.existsSync(path)) {
    return 'exists';
  }
  return 'missing';
}

module.exports = { checkConfig };
