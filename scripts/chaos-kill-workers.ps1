
param(
    [ValidateRange(1, 1440)]
    [int]$DurationMinutes = 30,

    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 2
)

$ErrorActionPreference = "Stop"

# Resolve project paths relative to this script.
$projectRoot = Split-Path -Parent $PSScriptRoot
$docsFolder = Join-Path $projectRoot "docs"

New-Item -ItemType Directory -Force -Path $docsFolder |
    Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $docsFolder "worker-kills-$timestamp.log"

$killCount = 0
$skipCount = 0
$errorCount = 0

function Write-Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"

    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

# Execute Docker while safely capturing stdout, stderr and exit code.
function Invoke-DockerCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $nativePreferenceExists = Test-Path variable:PSNativeCommandUseErrorActionPreference

    if ($nativePreferenceExists) {
        $previousNativePreference = $PSNativeCommandUseErrorActionPreference
    }

    try {
        $ErrorActionPreference = "Continue"

        if ($nativePreferenceExists) {
            $PSNativeCommandUseErrorActionPreference = $false
        }

        $output = @(& docker.exe @Arguments 2>&1)
        $exitCode = $LASTEXITCODE

        return [PSCustomObject]@{
            ExitCode = $exitCode
            Output   = @(
                $output | ForEach-Object { "$_" }
            )
        }
    }
    catch {
        return [PSCustomObject]@{
            ExitCode = 1
            Output   = @($_.Exception.Message)
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference

        if ($nativePreferenceExists) {
            $PSNativeCommandUseErrorActionPreference = $previousNativePreference
        }
    }
}

function Get-RunningWorkers {
    $result = Invoke-DockerCommand -Arguments @(
        "ps",
        "--filter",
        "label=com.docker.compose.service=worker",
        "--filter",
        "status=running",
        "--format",
        "{{.Names}}"
    )

    if ($result.ExitCode -ne 0) {
        throw "Could not list Docker workers: $($result.Output -join ' ')"
    }

    return @(
        $result.Output |
            Where-Object {
                $_ -match '^soup-job-queue-worker-[0-9]+$'
            }
    )
}

# JavaScript executed inside the selected worker container.
# It finds the real worker Node.js process, excluding PID 1
# and the temporary inspection process.
$killScript = @'
const fs = require("fs");

for (const p of fs.readdirSync("/proc")) {
  if (
    !/^\d+$/.test(p) ||
    Number(p) <= 1 ||
    Number(p) === process.pid
  ) {
    continue;
  }

  try {
    const commandLine = fs.readFileSync(
      "/proc/" + p + "/cmdline",
      "utf8"
    );

    const processName = fs.readFileSync(
      "/proc/" + p + "/comm",
      "utf8"
    ).trim();

    if (
      processName === "node" &&
      commandLine.includes("src/workers/worker-main.ts")
    ) {
      // Write confirmation before killing the worker.
      fs.writeSync(1, "WORKER_KILL_SENT:" + p + "\n");

      process.kill(Number(p), "SIGKILL");

      process.exitCode = 0;
      break;
    }
  } catch {
    // Process may have exited during inspection.
  }
}

if (process.exitCode !== 0) {
  fs.writeSync(2, "WORKER_PROCESS_NOT_FOUND\n");
  process.exitCode = 2;
}
'@

# Base64 avoids PowerShell changing JavaScript quotes and slashes.
$killScriptBase64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($killScript)
)

$nodeEval = "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))"

# Verify Docker is available.
$dockerCheck = Invoke-DockerCommand -Arguments @("info")

if ($dockerCheck.ExitCode -ne 0) {
    throw "Docker Desktop is unavailable. Start Docker Desktop first."
}

# Verify exactly eight workers are running.
$initialWorkers = @(Get-RunningWorkers)

if ($initialWorkers.Count -ne 8) {
    throw "Expected exactly 8 running workers, found $($initialWorkers.Count)."
}

Write-Log "=========================================="
Write-Log "Starting worker crash controller."
Write-Log "Initial running workers: $($initialWorkers.Count)"
Write-Log "Kill interval: approximately $IntervalSeconds seconds."
Write-Log "Maximum duration: $DurationMinutes minutes."
Write-Log "Log file: $logFile"
Write-Log "=========================================="

Write-Log "Waiting 10 seconds for the chaos test to start."
Start-Sleep -Seconds 10

$deadline = (Get-Date).AddMinutes($DurationMinutes)

try {
    while ((Get-Date) -lt $deadline) {

        try {
            $workers = @(Get-RunningWorkers)
        }
        catch {
            $errorCount++
            Write-Log "ERROR listing workers: $($_.Exception.Message)"
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        if ($workers.Count -eq 0) {
            Write-Log "WARNING: No running workers. Waiting for Docker restart."
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        $target = Get-Random -InputObject $workers

        Write-Log "Attempting SIGKILL in $target"

        # Pass only a simple eval expression and Base64 text to Docker.
        # This avoids Windows PowerShell native argument quote stripping.
        $result = Invoke-DockerCommand -Arguments @(
            "exec",
            $target,
            "node",
            "-e",
            $nodeEval,
            $killScriptBase64
        )

        foreach ($line in $result.Output) {
            Write-Log "Docker output: $line"
        }

        $killMarker = @(
            $result.Output |
                Where-Object {
                    $_ -match 'WORKER_KILL_SENT:\d+'
                }
        )

        if ($killMarker.Count -gt 0) {
            $killCount++

            $match = [regex]::Match(
                ($killMarker -join " "),
                'WORKER_KILL_SENT:(\d+)'
            )

            $workerPid = $match.Groups[1].Value

            Write-Log "SIGKILL sent to worker PID $workerPid in $target."
            Write-Log "Confirmed kill signals: $killCount"
        }
        else {
            $skipCount++

            Write-Log "WARNING: No kill confirmation received. Docker exit code: $($result.ExitCode)"
            Write-Log "Unconfirmed attempts: $skipCount"
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
}
finally {
    Write-Log "=========================================="
    Write-Log "Worker crash controller stopped."
    Write-Log "Confirmed SIGKILL signals: $killCount"
    Write-Log "Unconfirmed attempts: $skipCount"
    Write-Log "Controller errors: $errorCount"
    Write-Log "Full log: $logFile"
    Write-Log "=========================================="
}
