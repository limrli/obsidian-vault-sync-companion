param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)

$ErrorActionPreference = "Stop"

function Write-ResultFile {
  param(
    [bool]$Ok,
    [string]$Summary,
    [string]$ErrorMessage = ""
  )

  $result = [ordered]@{
    ok = $Ok
    summary = $Summary
    error = $ErrorMessage
    finishedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  }

  $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $script:ResultPath -Encoding UTF8
}

function Invoke-Git {
  param(
    [string[]]$Args
  )

  $output = & $script:GitBinary @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    $message = ($output | Out-String).Trim()
    if (-not $message) {
      $message = "git $($Args -join ' ') failed"
    }
    throw $message
  }
  return ($output | Out-String).Trim()
}

try {
  $payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
  $script:GitBinary = $payload.gitBinary
  $script:ResultPath = $payload.resultPath

  Set-Location -LiteralPath $payload.repoPath

  $status = Invoke-Git @("status", "--porcelain=v1", "--branch")
  $dirtyLines = @($status -split "`r?`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() })
  $hasDirty = $dirtyLines.Count -gt 0

  $createdCommit = $false
  if ($hasDirty) {
    Invoke-Git @("add", "-A") | Out-Null
    $staged = Invoke-Git @("diff", "--cached", "--name-only")
    if ($staged) {
      Invoke-Git @("commit", "-m", $payload.commitMessage) | Out-Null
      $createdCommit = $true
    }
  }

  $statusAfterCommit = Invoke-Git @("status", "--porcelain=v1", "--branch")
  $header = (($statusAfterCommit -split "`r?`n")[0]).Trim()
  $aheadMatch = [regex]::Match($header, "ahead\s+(\d+)")
  $behindMatch = [regex]::Match($header, "behind\s+(\d+)")
  $aheadCount = if ($aheadMatch.Success) { [int]$aheadMatch.Groups[1].Value } else { 0 }
  $behindCount = if ($behindMatch.Success) { [int]$behindMatch.Groups[1].Value } else { 0 }

  if ($createdCommit -or $aheadCount -gt 0 -or $behindCount -gt 0) {
    Invoke-Git @("fetch", $payload.remoteName, "--prune") | Out-Null

    $statusAfterFetch = Invoke-Git @("status", "--porcelain=v1", "--branch")
    $headerAfterFetch = (($statusAfterFetch -split "`r?`n")[0]).Trim()
    $behindAfterFetch = [regex]::Match($headerAfterFetch, "behind\s+(\d+)")
    $behindAfterFetchCount = if ($behindAfterFetch.Success) { [int]$behindAfterFetch.Groups[1].Value } else { 0 }

    if ($behindAfterFetchCount -gt 0) {
      Invoke-Git @("pull", "--rebase", $payload.remoteName, $payload.branchName) | Out-Null
    }

    Invoke-Git @("push", $payload.remoteName, $payload.branchName) | Out-Null
    $summary = if ($createdCommit) { "committed and pushed" } else { "pushed existing local commits" }
    Write-ResultFile -Ok $true -Summary $summary
  }
  else {
    Write-ResultFile -Ok $true -Summary "no local work to sync on close"
  }
}
catch {
  Write-ResultFile -Ok $false -Summary "close sync failed" -ErrorMessage $_.Exception.Message
}
finally {
  if (Test-Path -LiteralPath $PayloadPath) {
    Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
  }
}
