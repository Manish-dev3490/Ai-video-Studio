param(
  [Parameter(Mandatory)][ValidateSet('Run','Stop','Probe')][string]$Mode,
  [Parameter(Mandatory)][string]$JobName,
  [string]$NodeExecutable,
  [string]$Runner,
  [string]$RequestFile,
  [string]$GateFile,
  [int]$ParentPid = 0,
  [string]$ParentStartIdentity
)
$ErrorActionPreference = 'Stop'
if ($JobName -notmatch '^AVS-Render-[a-f0-9]{32}$') { throw 'INVALID_JOB_NAME' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class AvsProcessJob {
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IoCounters {public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;}
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits {public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;}
  [StructLayout(LayoutKind.Sequential)] public struct Accounting {public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static uint Active(IntPtr job) {Accounting info;if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero))throw new Exception("JOB_QUERY_FAILED");return info.ActiveProcesses;}
  public static bool StopOrProbe(string name,bool stop) {
    var job=OpenJobObject(stop ? 0x000Cu : 0x0004u,false,name);
    if(job==IntPtr.Zero) {if(Marshal.GetLastWin32Error()==2)return true;throw new Exception("JOB_OPEN_FAILED");}
    try {
      if(stop && !TerminateJobObject(job,1))throw new Exception("JOB_STOP_FAILED");
      for(var count=0;count<200;count++) {if(Active(job)==0)return true;if(!stop)return false;Thread.Sleep(50);}
      return false;
    } finally {CloseHandle(job);}
  }
  static bool ParentAlive(int pid,long ticks) {
    try {using(var parent=Process.GetProcessById(pid))return !parent.HasExited && parent.StartTime.ToUniversalTime().Ticks==ticks;}catch{return false;}
  }
  public static int Run(string name,string node,string runner,string request,string gate,int parentPid,long parentTicks) {
    var job=CreateJobObject(IntPtr.Zero,name);
    if(job==IntPtr.Zero || Marshal.GetLastWin32Error()==183)throw new Exception("JOB_CREATE_FAILED");
    Process process=null;
    try {
      var limits=new ExtendedLimits();limits.BasicLimitInformation.LimitFlags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>()))throw new Exception("JOB_LIMIT_FAILED");
      var info=new ProcessStartInfo(node);info.ArgumentList.Add(runner);info.ArgumentList.Add(request);info.ArgumentList.Add(gate);
      info.UseShellExecute=false;info.CreateNoWindow=true;info.WindowStyle=ProcessWindowStyle.Hidden;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
      process=new Process();process.StartInfo=info;
      process.OutputDataReceived+=(sender,args)=>{if(args.Data!=null)Console.WriteLine(args.Data);};
      process.ErrorDataReceived+=(sender,args)=>{if(args.Data!=null)Console.Error.WriteLine(args.Data);};
      process.Start();
      // Runner refuses work until this assignment succeeds. All subsequently
      // created Kokoro/Chrome/FFmpeg descendants inherit the native job.
      if(!AssignProcessToJobObject(job,process.Handle))throw new Exception("JOB_ASSIGN_FAILED");
      File.WriteAllText(gate,"ready");
      process.BeginOutputReadLine();process.BeginErrorReadLine();
      while(!process.WaitForExit(250)) {
        if(!ParentAlive(parentPid,parentTicks)) {
          if(!TerminateJobObject(job,1))throw new Exception("ORPHAN_JOB_STOP_FAILED");
          process.WaitForExit();break;
        }
      }
      process.WaitForExit();
      return process.ExitCode;
    } finally {
      if(process!=null && !process.HasExited) {try{process.Kill(true);}catch{}}
      CloseHandle(job);if(process!=null)process.Dispose();
    }
  }
}
'@
try {
  if ($Mode -eq 'Run') {
    if ($ParentPid -lt 1 -or $ParentStartIdentity -notmatch '^\d{15,20}$') { throw 'INVALID_PARENT_IDENTITY' }
    $result = [AvsProcessJob]::Run($JobName,$NodeExecutable,$Runner,$RequestFile,$GateFile,$ParentPid,[long]$ParentStartIdentity)
    exit $result
  }
  $stopped = [AvsProcessJob]::StopOrProbe($JobName,($Mode -eq 'Stop'))
  Write-Output ([ordered]@{event='ISOLATION_STATE';stopped=$stopped} | ConvertTo-Json -Compress)
  if (-not $stopped) { exit 2 }
} catch {
  [Console]::Error.WriteLine('{"code":"PROCESS_ISOLATION_FAILED","message":"Owned process isolation could not be verified."}')
  exit 1
}
