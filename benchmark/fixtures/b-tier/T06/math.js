'use strict';

function sum(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

function mean(arr) {
  if (!arr.length) return 0;
  return sum(arr) / arr.length;
}

module.exports = { sum, mean };
