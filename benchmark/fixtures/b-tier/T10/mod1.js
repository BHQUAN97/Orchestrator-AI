'use strict';

function parseConfig(raw) {
  if (!raw) {
    throw new Error('Empty config');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }
}

module.exports = { parseConfig };
