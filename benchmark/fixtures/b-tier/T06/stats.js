'use strict';

function sum(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

function variance(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = sum(arr) / n;
  let acc = 0;
  for (const x of arr) acc += (x - m) * (x - m);
  return acc / (n - 1);
}

module.exports = { sum, variance };
