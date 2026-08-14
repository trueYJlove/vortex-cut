[CmdletBinding()]
param(
    [ValidateSet('success', 'stdout_captured', 'duplicate', 'conflict', 'unknown')]
    [string]$Mode,
    [string]$Probe
)

$expectedProbe = 'quote " 中文 C:\path with space\'
if ($Probe -ne $expectedProbe) {
    [Console]::Out.Write('1 failed, 0 passed, 0 skipped')
    [Console]::Error.Write('AIVS_SAFE_RESULT code=REAL_PROVIDER_AUDIT_HTTP_FAILURE')
    exit 1
}
if ($Mode -eq 'success') {
    [Console]::Out.Write('1 passed in 0.01s')
    exit 0
}
[Console]::Out.Write('1 failed, 0 passed, 0 skipped')
switch ($Mode) {
    'stdout_captured' {
        [Console]::Out.Write("`r`nCaptured stderr call`r`n  AIVS_SAFE_RESULT code=REAL_PROVIDER_AUDIT_HTTP_FAILURE`r`n")
        [Console]::Error.Write("sensitive sentinel ' 中文 C:\path with space\")
    }
    'duplicate' {
        [Console]::Out.Write("`r`n AIVS_SAFE_RESULT code=REAL_PROVIDER_AUDIT_HTTP_FAILURE`r`n")
        [Console]::Error.Write("sensitive sentinel`r`nAIVS_SAFE_RESULT code=REAL_PROVIDER_AUDIT_HTTP_FAILURE")
    }
    'conflict' {
        [Console]::Out.Write("`r`nAIVS_SAFE_RESULT code=REAL_PROVIDER_AUDIT_HTTP_FAILURE`r`n")
        [Console]::Error.Write("AIVS_SAFE_RESULT code=REAL_PROVIDER_PROVIDER_TIMEOUT")
    }
    'unknown' {
        [Console]::Out.Write("`r`nAIVS_SAFE_RESULT code=NOT_A_FORMAL_CODE`r`n")
        [Console]::Error.Write("sensitive sentinel ' 中文 C:\path with space\")
    }
}
exit 1
