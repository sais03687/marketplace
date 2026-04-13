Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*agentmail-poller*' } |
  ForEach-Object {
    Write-Host "Killing PID $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length)))"
    Stop-Process -Id $_.ProcessId -Force
  }
