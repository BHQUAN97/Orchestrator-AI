'use strict';

/**
 * Update terminal/CMD/PowerShell window title via ANSI OSC escape.
 * Works on: Windows Terminal, ConEmu, iTerm2, most modern terminals.
 */
function setTitle(title) {
  if (process.stdout.isTTY) {
    // ◆ prefix giống Claude Code — hiện trong tab Windows Terminal / ConEmu
    process.stdout.write(`\x1b]0;◆ ${title}\x07`);
  }
}

module.exports = { setTitle };
