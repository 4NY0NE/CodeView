// Descobre quais programas estão EMITINDO som agora (sessões de áudio do Windows).
// Roda um PowerShell que fica ligado só enquanto a tela de escolha está aberta e imprime uma linha por segundo:
//   AW|pid,estado,pico:pai1:pai2;pid,estado,pico:pai1...      (estado 1 = tocando)
// O pid de uma sessão costuma ser de um processo filho (ex.: o navegador toca o som por um filho),
// por isso vai junto a cadeia de processos pai, para o app achar a janela dona do som.
const { spawn } = require("child_process");

const CS = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class AW {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDE {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint i, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr g, uint f, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr g, uint f, out IntPtr v);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
  }
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr n);
    [PreserveSig] int SetDisplayName(IntPtr n, ref Guid c);
    [PreserveSig] int GetIconPath(out IntPtr p);
    [PreserveSig] int SetIconPath(IntPtr p, ref Guid c);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid o, ref Guid c);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier(out IntPtr s);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr s);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }
  public static string Run() {
    var sb = new StringBuilder();
    var en = (IMMDeviceEnumerator)(new MMDE());
    IMMDeviceCollection col; if (en.EnumAudioEndpoints(0, 1, out col) != 0) return "";
    uint n; col.GetCount(out n);
    for (uint i = 0; i < n; i++) {
      IMMDevice d; if (col.Item(i, out d) != 0) continue;
      object o; Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
      var mgr = (IAudioSessionManager2)o; IAudioSessionEnumerator se;
      if (mgr.GetSessionEnumerator(out se) != 0) continue;
      int c; se.GetCount(out c);
      for (int k = 0; k < c; k++) {
        IAudioSessionControl2 ctl; if (se.GetSession(k, out ctl) != 0) continue;
        int st; uint pid; float pk = 0f;
        if (ctl.GetState(out st) != 0 || ctl.GetProcessId(out pid) != 0 || pid == 0) continue;
        try { ((IAudioMeterInformation)ctl).GetPeakValue(out pk); } catch {}
        if (sb.Length > 0) sb.Append(';');
        sb.Append(pid).Append(',').Append(st).Append(',').Append(pk.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture));
      }
    }
    return sb.ToString();
  }
}`;

const PS = `
$src = @"
${CS}
"@
$ErrorActionPreference = 'Stop'
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
try { Add-Type -TypeDefinition $src } catch { [Console]::Out.WriteLine('AW|ERR'); [Console]::Out.Flush(); exit 1 }
$map = @{}; $n = 0
while ($true) {
  try {
    if ($n % 10 -eq 0) { $map = @{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { $map[[int]$_.ProcessId] = [int]$_.ParentProcessId } }
    $n++
    $out = @()
    foreach ($e in ([AW]::Run() -split ';')) {
      if (-not $e) { continue }
      $f = $e.Split(',')
      $c = [int]$f[0]; $chain = @()
      for ($i = 0; $i -lt 10; $i++) { if (-not $map.ContainsKey($c)) { break }; $c = $map[$c]; if ($c -le 0) { break }; $chain += $c }
      $out += ($e + ':' + ($chain -join ':'))
    }
    [Console]::Out.WriteLine('AW|' + ($out -join ';'))
  } catch { [Console]::Out.WriteLine('AW|ERR') }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1500
}
`;

let proc = null, latest = null, idle = null, waiters = [];

function parse(line) {
  if (!line.startsWith("AW|")) return;
  const body = line.slice(3).trim();
  if (body === "ERR") latest = { err: true, sessions: [], at: Date.now() };
  else latest = {
    err: false, at: Date.now(),
    sessions: body.split(";").filter(Boolean).map(x => {
      const [head, ...chain] = x.split(":"), [pid, st, pk] = head.split(",");
      return { pid: String(pid), state: Number(st), peak: Number(pk) || 0, chain: chain.filter(Boolean).map(String) };
    }),
  };
  const w = waiters; waiters = []; w.forEach(f => f());
}

function stop() {
  if (idle) { clearTimeout(idle); idle = null; }
  if (proc) { try { proc.kill(); } catch {} proc = null; }
  latest = null;
  const w = waiters; waiters = []; w.forEach(f => f());
}

function start() {
  if (proc || process.platform !== "win32") return;
  try {
    const b64 = Buffer.from(PS, "utf16le").toString("base64");
    proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { parse(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); } });
    proc.on("error", () => { latest = { err: true, sessions: [], at: Date.now() }; proc = null; });
    proc.on("exit", () => { proc = null; });
  } catch { latest = { err: true, sessions: [], at: Date.now() }; }
}

// devolve a última leitura (espera até 4 s pela primeira); desliga sozinho 20 s depois do último pedido
async function snapshot() {
  start();
  if (idle) clearTimeout(idle);
  idle = setTimeout(stop, 20000);
  if (!latest) await new Promise(res => { waiters.push(res); setTimeout(res, 4000); });
  return latest && !latest.err && Date.now() - latest.at < 6000 ? latest : null;
}

module.exports = { snapshot, stop };
