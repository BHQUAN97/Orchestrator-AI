'use strict';

function loadTool(name) {
  if (!name) {
    return { success: false, error: 'name required' };
  }
  if (name.length > 50) {
    return { success: false, error: 'name too long' };
  }
  return { success: true, tool: { name } };
}

module.exports = { loadTool };
