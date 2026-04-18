'use strict';
const fs = require('fs');

function validate(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Directory not found: ${dir}`);
  }
  return true;
}

module.exports = { validate };
