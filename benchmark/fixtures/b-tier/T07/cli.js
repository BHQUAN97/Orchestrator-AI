#!/usr/bin/env node
'use strict';

// Simple CLI — process.argv parsing
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: cli.js [--help]');
  process.exit(0);
}

const name = args[0] || 'world';
console.log(`Hello, ${name}!`);
