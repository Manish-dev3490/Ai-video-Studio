# Requires PowerShell 7 on Windows. This wrapper does not install or download anything.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][ValidateSet(30, 60, 90)][int]$Target,
    [ValidateRange(30, 1440)][int]$TimeoutMinutes = 90,
    [string]$BrowserExecutable,
    [string]$ModelDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7 on Windows; ProcessStartInfo.ArgumentList is required.' }
if (-not [IO.Path]::IsPathFullyQualified($OutputRoot)) { throw 'OutputRoot must be an absolute path.' }
$engineRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $engineRoot '../..'))
$outputDirectory = [IO.Path]::GetFullPath($OutputRoot)
foreach ($name in @('docs', 'review', 'video-engine-poc', '.git')) {
    $protectedPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $name)).TrimEnd('\')
    if ($outputDirectory.Equals($protectedPath, [StringComparison]::OrdinalIgnoreCase) -or $outputDirectory.StartsWith($protectedPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Benchmark evidence must stay outside approved documents and the preserved prototype.' }
}
$nodeExecutable = (Get-Command node -CommandType Application | Select-Object -First 1).Source
if (-not $nodeExecutable) { throw 'An installed Node.js executable is required.' }
# Resolve junctions/symlinks before creating any metrics or output directories.
# Values are separate arguments, never inserted into JavaScript or shell text.
$pathPreflightSource = @'
const fs = require('node:fs');
const path = require('node:path');
function prospectiveRealpath(input) {
  let current = path.resolve(input);
  const missing = [];
  for (;;) {
    try {
      return path.resolve(fs.realpathSync.native(current), ...missing.slice().reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // An existing broken junction is not a missing directory to reconstruct.
      try { fs.lstatSync(current); throw new Error('UNRESOLVABLE_OUTPUT_ANCESTOR'); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
try {
  const resolvedOutput = prospectiveRealpath(process.argv[1]);
  const repository = prospectiveRealpath(process.argv[2]);
  for (const name of ['docs', 'review', 'video-engine-poc', '.git']) {
    const protectedRoot = prospectiveRealpath(path.join(repository, name));
    const relative = path.relative(protectedRoot, resolvedOutput);
    if (relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
      throw new Error('PROTECTED_OUTPUT_DIRECTORY');
    }
  }
  process.stdout.write(JSON.stringify({outputRoot: resolvedOutput}));
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
'@
$pathStartInfo = [Diagnostics.ProcessStartInfo]::new()
$pathStartInfo.FileName = $nodeExecutable
$pathStartInfo.UseShellExecute = $false
$pathStartInfo.CreateNoWindow = $true
$pathStartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$pathStartInfo.RedirectStandardOutput = $true
$pathStartInfo.RedirectStandardError = $true
foreach ($argument in @('-e', $pathPreflightSource, '--', $outputDirectory, $repositoryRoot)) { $pathStartInfo.ArgumentList.Add($argument) }
$pathProcess = [Diagnostics.Process]::new()
$pathProcess.StartInfo = $pathStartInfo
try {
    $null = $pathProcess.Start()
    $pathStdoutTask = $pathProcess.StandardOutput.ReadToEndAsync()
    $pathStderrTask = $pathProcess.StandardError.ReadToEndAsync()
    $pathProcess.WaitForExit()
    $pathStdout = $pathStdoutTask.GetAwaiter().GetResult()
    $pathStderr = $pathStderrTask.GetAwaiter().GetResult()
    if ($pathProcess.ExitCode -ne 0) { throw ('Output path preflight rejected the directory: ' + $pathStderr.Trim()) }
    $outputDirectory = ($pathStdout | ConvertFrom-Json).outputRoot
    if (-not $outputDirectory -or -not [IO.Path]::IsPathFullyQualified($outputDirectory)) { throw 'Output path preflight returned an invalid directory.' }
} finally { $pathProcess.Dispose() }
$driver = Join-Path $PSScriptRoot 'validate-phase2.js'
if (-not (Test-Path -LiteralPath $driver -PathType Leaf)) { throw 'The existing Phase 2 validation driver is required.' }

# Built-in Windows APIs avoid WMI/CIM permissions and external dependencies.
if (-not ('PhaseTwoBenchmarkNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PhaseTwoBenchmarkNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessEntry {
        public uint size, usage, processId;
        public UIntPtr defaultHeapId;
        public uint moduleId, threads, parentProcessId;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryStatus {
        public uint length, load;
        public ulong totalPhysical, availablePhysical, totalPageFile, availablePageFile, totalVirtual, availableVirtual, availableExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    public static ProcessEntry[] Processes() {
        var handle = CreateToolhelp32Snapshot(2, 0);
        if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        try {
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf<ProcessEntry>() };
            var list = new List<ProcessEntry>();
            if (Process32FirstW(handle, ref entry)) do { list.Add(entry); } while (Process32NextW(handle, ref entry));
            return list.ToArray();
        } finally { CloseHandle(handle); }
    }
    public static MemoryStatus Memory() {
        var value = new MemoryStatus { length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref value)) throw new System.ComponentModel.Win32Exception();
        return value;
    }
}
'@
}

$null = [IO.Directory]::CreateDirectory($outputDirectory)
$metricsName = 'metrics-{0}-{1}-{2}' -f $Target, [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), [Guid]::NewGuid().ToString('N')
$metricsDirectory = Join-Path $outputDirectory $metricsName
$null = New-Item -ItemType Directory -Path $metricsDirectory
function Save-MetricJson($Value, [string]$Name) {
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $metricsDirectory $Name) -Encoding utf8
}

$arguments = @($driver, '--output-root', $outputDirectory, '--only', [string]$Target, '--resume')
if ($BrowserExecutable) { $arguments += @('--browser', [IO.Path]::GetFullPath($BrowserExecutable)) }
if ($ModelDirectory) { $arguments += @('--model-dir', [IO.Path]::GetFullPath($ModelDirectory)) }
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodeExecutable
$startInfo.WorkingDirectory = $engineRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in $arguments) { $startInfo.ArgumentList.Add($argument) }
$startInfo.Environment['NO_COLOR'] = '1'
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$memoryBefore = [PhaseTwoBenchmarkNative]::Memory()
Save-MetricJson ([ordered]@{
    platform=[Environment]::OSVersion.VersionString; powershell=$PSVersionTable.PSVersion.ToString()
    nodeExecutable=$nodeExecutable; nodeFileVersion=(Get-Item -LiteralPath $nodeExecutable).VersionInfo.ProductVersion
    logicalProcessors=[Environment]::ProcessorCount; totalPhysicalBytes=$memoryBefore.totalPhysical
    systemAvailablePhysicalBytesBefore=$memoryBefore.availablePhysical; timezone=[TimeZoneInfo]::Local.Id
    targetSeconds=$Target; outputRoot=$outputDirectory; workingDirectory=$engineRoot; arguments=$arguments
    sampleIntervalMilliseconds=1000; timeoutMinutes=$TimeoutMinutes
}) 'environment.json'

$watch = [Diagnostics.Stopwatch]::StartNew()
$started = $false
$timedOut = $false
$failure = $null
$exitCode = $null
$peakWorkingSet = 0L
$peakPrivate = 0L
$minimumFreeMemory = [long]$memoryBefore.availablePhysical
$sampleCount = 0
$maximumProcessCount = 0
$tracked = @{}
$observed = @{}
$cpuByIdentity = @{}
$csv = [IO.StreamWriter]::new((Join-Path $metricsDirectory 'process-tree-metrics.csv'), $false)
$csv.WriteLine('elapsedSeconds,processCount,workingSetBytes,privateBytes,systemAvailablePhysicalBytes')
$stdoutTask = $null
$stderrTask = $null
$processStarted = $null
$childWallSeconds = $null
try {
    $null = $process.Start()
    $started = $true
    $processStarted = $process.StartTime.ToUniversalTime()
    $tracked[$process.Id] = $processStarted.Ticks
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $nextProgress = 20.0
    Write-Output ('Started target={0}s, rootPid={1}, metrics={2}' -f $Target, $process.Id, $metricsDirectory)
    while (-not $process.HasExited) {
        $entries = [PhaseTwoBenchmarkNative]::Processes()
        $entriesById = @{}
        foreach ($entry in $entries) { $entriesById[[int]$entry.processId] = $entry }
        # Start-time identities exclude a new process that reuses a tracked PID.
        foreach ($trackedId in @($tracked.Keys)) {
            if (-not $entriesById.ContainsKey($trackedId)) { continue }
            $candidate = $null
            try {
                $candidate = [Diagnostics.Process]::GetProcessById($trackedId)
                if ($candidate.StartTime.ToUniversalTime().Ticks -ne $tracked[$trackedId]) { $tracked.Remove($trackedId) }
            } catch { } finally { if ($candidate) { $candidate.Dispose() } }
        }
        do {
            $changed = $false
            foreach ($entry in $entries) {
                $childId = [int]$entry.processId
                $parentId = [int]$entry.parentProcessId
                if ($tracked.ContainsKey($childId) -or -not $tracked.ContainsKey($parentId)) { continue }
                $child = $null
                try {
                    $child = [Diagnostics.Process]::GetProcessById($childId)
                    $ticks = $child.StartTime.ToUniversalTime().Ticks
                    if ($ticks -ge $tracked[$parentId] -and $ticks -ge $processStarted.Ticks) {
                        $tracked[$childId] = $ticks
                        $changed = $true
                    }
                } catch { } finally { if ($child) { $child.Dispose() } }
            }
        } while ($changed)
        $workingSet = 0L
        $privateBytes = 0L
        $processCount = 0
        foreach ($trackedId in @($tracked.Keys)) {
            $child = $null
            try {
                $child = [Diagnostics.Process]::GetProcessById($trackedId)
                $child.Refresh()
                if ($child.StartTime.ToUniversalTime().Ticks -ne $tracked[$trackedId]) { continue }
                $workingSet += $child.WorkingSet64
                $privateBytes += $child.PrivateMemorySize64
                $identity = '{0}:{1}' -f $trackedId, $tracked[$trackedId]
                $cpuByIdentity[$identity] = $child.TotalProcessorTime.TotalSeconds
                $observed[$identity] = $child.ProcessName
                $processCount++
            } catch { } finally { if ($child) { $child.Dispose() } }
        }
        $memory = [PhaseTwoBenchmarkNative]::Memory()
        $peakWorkingSet = [Math]::Max($peakWorkingSet, $workingSet)
        $peakPrivate = [Math]::Max($peakPrivate, $privateBytes)
        $minimumFreeMemory = [Math]::Min($minimumFreeMemory, [long]$memory.availablePhysical)
        $maximumProcessCount = [Math]::Max($maximumProcessCount, $processCount)
        $elapsed = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
        $csv.WriteLine(('{0},{1},{2},{3},{4}' -f $elapsed.ToString([Globalization.CultureInfo]::InvariantCulture), $processCount, $workingSet, $privateBytes, $memory.availablePhysical))
        $csv.Flush()
        $sampleCount++
        if ($watch.Elapsed.TotalSeconds -ge $nextProgress) {
            $progress = [ordered]@{targetSeconds=$Target; elapsedSeconds=$elapsed; processCount=$processCount; sampledPeakWorkingSetBytes=$peakWorkingSet; sampledPeakPrivateBytes=$peakPrivate; metricsDirectory=$metricsDirectory}
            Save-MetricJson $progress 'progress.json'
            Write-Output ('Target={0}s elapsed={1:N0}s processes={2} RSS={3:N1}MiB peak={4:N1}MiB free={5:N0}MiB' -f $Target, $elapsed, $processCount, ($workingSet / 1MB), ($peakWorkingSet / 1MB), ($memory.availablePhysical / 1MB))
            $nextProgress = $watch.Elapsed.TotalSeconds + 20
        }
        if ($watch.Elapsed.TotalMinutes -ge $TimeoutMinutes) {
            $timedOut = $true
            throw 'The benchmark exceeded its configured timeout.'
        }
        Start-Sleep -Milliseconds 1000
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
} catch {
    $failure = $_.Exception.Message
} finally {
    if ($started) {
        # Never enumerate and kill arbitrary process names or system-wide PIDs.
        if (-not $process.HasExited) {
            try { $process.Kill($true); $process.WaitForExit() } catch { $failure = 'Unable to stop the benchmark child tree: ' + $_.Exception.Message }
        }
        if ($process.HasExited) {
            $exitCode = $process.ExitCode
            $childWallSeconds = ($process.ExitTime.ToUniversalTime() - $processStarted).TotalSeconds
            try { $cpuByIdentity[('{0}:{1}' -f $process.Id, $processStarted.Ticks)] = $process.TotalProcessorTime.TotalSeconds } catch { }
        }
        if ($stdoutTask) { $stdoutTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $metricsDirectory 'stdout.log') -Encoding utf8 }
        if ($stderrTask) { $stderrTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $metricsDirectory 'stderr.log') -Encoding utf8 }
    }
    $watch.Stop()
    $csv.Dispose()
    $summary = [ordered]@{
        targetSeconds=$Target; startedAtUtc=if ($processStarted) {$processStarted.ToString('o')} else {$null}
        completedAtUtc=[DateTime]::UtcNow.ToString('o')
        elapsedSeconds=if ($null -ne $childWallSeconds) {[Math]::Round($childWallSeconds, 3)} else {$null}
        observationSeconds=[Math]::Round($watch.Elapsed.TotalSeconds, 3)
        exitCode=$exitCode; timedOut=$timedOut; wrapperError=$failure; sampleCount=$sampleCount
        sampledPeakWorkingSetBytes=$peakWorkingSet; sampledPeakPrivateBytes=$peakPrivate
        systemAvailablePhysicalBytesBefore=[long]$memoryBefore.availablePhysical; systemMinimumAvailablePhysicalBytes=$minimumFreeMemory
        sampledCpuSecondsLowerBound=[Math]::Round([double](($cpuByIdentity.Values | Measure-Object -Sum).Sum), 3)
        maximumConcurrentObservedProcessCount=$maximumProcessCount; discoveredProcessIdentityCount=$observed.Count
        observedProcessNames=@($observed.Values | Sort-Object -Unique); outputRoot=$outputDirectory; metricsDirectory=$metricsDirectory
        executable=$nodeExecutable; arguments=$arguments
        limitations=@('One-second sampling may miss short-lived children and memory peaks.', 'Summed working sets include shared pages and are not unique physical memory usage.', 'Sampled descendant CPU seconds are a lower bound.', 'System available memory includes unrelated host activity.', 'The resume driver may reuse a completed result; inspect its benchmark report before treating this as a fresh render.')
    }
    Save-MetricJson $summary 'summary.json'
    $process.Dispose()
    Write-Output ('Finished target={0}s exit={1} wall={2:N1}s sampled RSS peak={3:N1}MiB metrics={4}' -f $Target, $exitCode, $summary.elapsedSeconds, ($peakWorkingSet / 1MB), $metricsDirectory)
}
if ($failure) { throw $failure }
if ($exitCode -ne 0) { throw ('Phase 2 validation exited with code {0}. Inspect retained stdout.log and stderr.log.' -f $exitCode) }
