'use strict';

// Thong tin he thong: CPU/RAM/Disk/GPU — fast path (~1s)
const os = require('os');
const { runPowerShell } = require('./ps-bridge');

// Tinh CPU usage bang cach do 2 snapshot cpus()
function cpuUsagePercent(intervalMs = 150) {
  return new Promise((resolve) => {
    const start = os.cpus();
    setTimeout(() => {
      const end = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;
      for (let i = 0; i < end.length; i++) {
        const s = start[i].times;
        const e = end[i].times;
        const idleDiff = e.idle - s.idle;
        const totalDiff =
          (e.user - s.user) +
          (e.nice - s.nice) +
          (e.sys - s.sys) +
          (e.idle - s.idle) +
          (e.irq - s.irq);
        totalIdle += idleDiff;
        totalTick += totalDiff;
      }
      const usage = totalTick > 0 ? (1 - totalIdle / totalTick) * 100 : 0;
      resolve(Math.round(usage * 10) / 10);
    }, intervalMs);
  });
}

async function getDisksAndGpu() {
  // Goi 1 script PS de vua lay disk vua lay GPU — tiet kiem spawn
  const script = `
$ProgressPreference = 'SilentlyContinue'
$disks = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction SilentlyContinue |
  Where-Object { $_.DriveType -eq 3 } |
  ForEach-Object {
    [PSCustomObject]@{
      drive = $_.DeviceID
      total_gb = [math]::Round($_.Size / 1GB, 2)
      free_gb = [math]::Round($_.FreeSpace / 1GB, 2)
      used_percent = if ($_.Size -gt 0) { [math]::Round((($_.Size - $_.FreeSpace) / $_.Size) * 100, 1) } else { 0 }
      fs = $_.FileSystem
    }
  }
$gpus = Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue |
  ForEach-Object {
    [PSCustomObject]@{
      name = $_.Name
      driver_version = $_.DriverVersion
      ram_mb = if ($_.AdapterRAM) { [math]::Round($_.AdapterRAM / 1MB, 0) } else { $null }
    }
  }
[PSCustomObject]@{ disks = @($disks); gpu = @($gpus) } | ConvertTo-Json -Depth 4 -Compress
`;
  const res = await runPowerShell({ script, timeout: 8000 });
  // Parse stdout du exit code != 0 (CLIXML noise)
  try {
    const raw = (res.stdout || '').trim();
    if (!raw) return { disks: [], gpu: [] };
    const j = JSON.parse(raw);
    return {
      disks: Array.isArray(j.disks) ? j.disks : (j.disks ? [j.disks] : []),
      gpu: Array.isArray(j.gpu) ? j.gpu : (j.gpu ? [j.gpu] : []),
    };
  } catch (_) {
    return { disks: [], gpu: [] };
  }
}

async function sysInfo() {
  try {
    const cpus = os.cpus() || [];
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // Chay song song: CPU usage sampling + WMI disk/GPU
    const [usage_percent, extra] = await Promise.all([
      cpuUsagePercent(150),
      getDisksAndGpu(),
    ]);

    const info = {
      success: true,
      cpu: {
        cores: cpus.length,
        model: cpus[0] ? cpus[0].model : 'unknown',
        usage_percent,
      },
      memory: {
        total_gb: Math.round((totalMem / (1024 ** 3)) * 100) / 100,
        free_gb: Math.round((freeMem / (1024 ** 3)) * 100) / 100,
        used_percent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0,
      },
      disks: extra.disks,
      gpu: extra.gpu,
      os: {
        platform: process.platform,
        release: os.release(),
        hostname: os.hostname(),
        uptime_hours: Math.round((os.uptime() / 3600) * 10) / 10,
      },
    };
    return info;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sysInfo };
