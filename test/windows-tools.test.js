#!/usr/bin/env node
/**
 * Test cho Windows deep-integration tools:
 *  - registry: read HKCU, reject writes without confirm, reject dangerous paths
 *  - scheduled-tasks: list tasks, reject create/delete without confirm
 *  - services: list services, reject start/stop without confirm, reject critical
 *
 * Skip non-Windows platforms de CI khong fail.
 */
'use strict';

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  [OK] ${name}`); passed++; }
  else { console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`); failed++; }
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('Skipping windows-tools tests — not on Windows');
    process.exit(0);
  }

  const {
    registryGet, registrySet, registryDelete,
    tasksList, tasksCreate, tasksDelete,
    servicesList, servicesStart, servicesStop, servicesSetStartType,
  } = require('../tools/windows');

  // === Registry ===
  console.log('\n=== Registry ===');
  const rg = await registryGet({ path: 'HKCU:\\Environment', valueName: 'Path' });
  assert('registryGet HKCU:\\Environment Path returns ok', rg.ok === true, JSON.stringify(rg).slice(0, 200));
  assert('registryGet has data.value', rg.ok && rg.data && rg.data.value != null);

  const rsNoConfirm = await registrySet({ path: 'HKCU:\\Software\\OrcaiTest', valueName: 'X', value: '1' });
  assert('registrySet rejects without confirm', rsNoConfirm.ok === false && /confirm/i.test(rsNoConfirm.error));

  const rsDanger = await registrySet({ path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Foo', valueName: 'X', value: '1', confirm: true });
  assert('registrySet rejects dangerous path', rsDanger.ok === false && /protected|confirm/i.test(rsDanger.error));

  const rdNoConfirm = await registryDelete({ path: 'HKCU:\\Software\\OrcaiTest' });
  assert('registryDelete rejects without confirm', rdNoConfirm.ok === false && /confirm/i.test(rdNoConfirm.error));

  // === Scheduled Tasks ===
  console.log('\n=== Scheduled Tasks ===');
  const tl = await tasksList({});
  assert('tasksList returns ok', tl.ok === true);
  assert('tasksList data is array', Array.isArray(tl.data));

  const tcNoConfirm = await tasksCreate({ name: 'OrcaiTest', command: 'notepad', schedule: 'ONCE', startTime: '23:59' });
  assert('tasksCreate rejects without confirm', tcNoConfirm.ok === false && /confirm/i.test(tcNoConfirm.error));

  const tdNoConfirm = await tasksDelete({ name: 'OrcaiTest' });
  assert('tasksDelete rejects without confirm', tdNoConfirm.ok === false && /confirm/i.test(tdNoConfirm.error));

  // === Services ===
  console.log('\n=== Services ===');
  const sl = await servicesList({ filter: 'win' });
  assert('servicesList returns ok', sl.ok === true);
  assert('servicesList has >= 1 entry', Array.isArray(sl.data) && sl.data.length >= 1, `got ${sl.data && sl.data.length}`);

  const ssNoConfirm = await servicesStart({ name: 'Spooler' });
  assert('servicesStart rejects without confirm', ssNoConfirm.ok === false && /confirm/i.test(ssNoConfirm.error));

  const spCritical = await servicesStop({ name: 'winmgmt', confirm: true });
  assert('servicesStop rejects critical service (winmgmt)', spCritical.ok === false && /critical/i.test(spCritical.error));

  const spRpc = await servicesStop({ name: 'RPCSS', confirm: true });
  assert('servicesStop rejects critical service (RPCSS case-insensitive)', spRpc.ok === false && /critical/i.test(spRpc.error));

  const stNoConfirm = await servicesSetStartType({ name: 'Spooler', type: 'Manual' });
  assert('servicesSetStartType rejects without confirm', stNoConfirm.ok === false && /confirm/i.test(stNoConfirm.error));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
