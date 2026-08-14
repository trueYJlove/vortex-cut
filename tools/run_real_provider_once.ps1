[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$Run
)

# -Run is reserved for one separately authorized execution; this script never retries.
$ErrorActionPreference = 'Stop'

$script:FormalSafeCodes = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@(
        'REAL_PROVIDER_AUDIT_INVALID_ERROR_CODE',
        'REAL_PROVIDER_AUDIT_REQUEST_BUILD_FAILURE',
        'REAL_PROVIDER_AUDIT_HTTP_FAILURE',
        'REAL_PROVIDER_PROVIDER_TRANSPORT_FAILED',
        'REAL_PROVIDER_PROVIDER_TIMEOUT',
        'REAL_PROVIDER_PROVIDER_HTTP_FAILED',
        'REAL_PROVIDER_PROVIDER_SCHEMA_CAPABILITY_FAILED',
        'REAL_PROVIDER_CANDIDATE_JOB_TIMEOUT',
        'REAL_PROVIDER_AUDIT_REQUEST_JSON_INVALID',
        'REAL_PROVIDER_AUDIT_ENDPOINT_INVALID',
        'REAL_PROVIDER_AUDIT_AUTH_MISSING',
        'REAL_PROVIDER_AUDIT_RESPONSE_FORMAT_INVALID',
        'REAL_PROVIDER_AUDIT_JSON_SCHEMA_INVALID',
        'REAL_PROVIDER_AUDIT_SCHEMA_TYPE_INVALID',
        'REAL_PROVIDER_AUDIT_SCHEMA_NAME_INVALID',
        'REAL_PROVIDER_AUDIT_SCHEMA_STRICT_INVALID',
        'REAL_PROVIDER_AUDIT_ENVELOPE_INVALID',
        'REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS',
        'REAL_PROVIDER_CANDIDATE_JOB_FAILED',
        'REAL_PROVIDER_AUDIT_CALL_COUNT_INVALID',
        'REAL_PROVIDER_AUDIT_ENDPOINT_KIND_INVALID',
        'REAL_PROVIDER_AUDIT_SCHEMA_NOT_VALIDATED',
        'REAL_PROVIDER_AUDIT_EGRESS_NOT_VALIDATED',
        'REAL_PROVIDER_CANDIDATE_VARIANTS_INVALID',
        'REAL_PROVIDER_INVOCATION_MISSING',
        'REAL_PROVIDER_USAGE_MISSING',
        'REAL_PROVIDER_ESTIMATE_MISSING',
        'REAL_PROVIDER_ACTUAL_COST_PRESENT',
        'REAL_PROVIDER_OUTPUT_HASH_INVALID',
        'REAL_PROVIDER_DURATION_MISSING',
        'REAL_PROVIDER_AUDIT_SENSITIVE_PERSISTENCE',
        'REAL_PROVIDER_SECRET_DELETION_FAILED',
        'REAL_PROVIDER_MISSING_CREDENTIAL_NOT_REJECTED',
        'REAL_PROVIDER_MISSING_CREDENTIAL_CODE_INVALID',
        'REAL_PROVIDER_UNEXPECTED_RETRY',
        'REAL_PROVIDER_BRIEF_REQUEST_FAILED',
        'REAL_PROVIDER_CONFIG_REQUEST_FAILED',
        'REAL_PROVIDER_SECRET_INJECTION_FAILED',
        'REAL_PROVIDER_PREPARE_FAILED',
        'REAL_PROVIDER_GENERATION_REQUEST_FAILED',
        'REAL_PROVIDER_REDACTION_CODE_INVALID',
        'REAL_PROVIDER_REDACTION_TEST_KEY_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_PROMPT_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_RESPONSE_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_AUTH_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_REQUEST_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_RESPONSE_CONTEXT_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_JOB_ERROR_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED',
        'REAL_PROVIDER_REDACTION_TEST_VARIABLE_COLLECTED',
        'REAL_PROVIDER_TEST_EXECUTION_FAILED',
        'REAL_PROVIDER_ENVIRONMENT_INVALID'
    )
)
$script:RunnerSafeCodes = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@(
        'RUNNER_NONE',
        'RUNNER_MODE_REQUIRED',
        'RUNNER_SELFTEST_FAILED',
        'RUNNER_CONFIG_MISSING',
        'RUNNER_USER_ENABLEMENT_INVALID',
        'RUNNER_START_FAILED',
        'RUNNER_RESULT_UNCLASSIFIED'
    )
)
$script:UserConfigNames = [string[]]@(
    'AIVS_REAL_PROVIDER_BASE_URL',
    'AIVS_REAL_PROVIDER_MODEL',
    'AIVS_REAL_PROVIDER_API_KEY',
    'AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION',
    'AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION',
    'AIVS_REAL_PROVIDER_EXPECTED_ADAPTER',
    'AIVS_REAL_PROVIDER_TIMEOUT'
)

function New-Summary {
    param(
        [string]$Status,
        [bool]$PytestStarted,
        [int]$ExitCode,
        [int]$PassedCount,
        [int]$FailedCount,
        [int]$SkippedCount,
        [string]$SafeCode,
        [bool]$ConfigurationComplete
    )
    return [ordered]@{
        schema_version = 1
        status = $Status
        pytest_started = $PytestStarted
        exit_code = $ExitCode
        passed_count = $PassedCount
        failed_count = $FailedCount
        skipped_count = $SkippedCount
        safe_code = $SafeCode
        configuration_complete = $ConfigurationComplete
    }
}

function Get-Count {
    param([string]$Output, [string]$Name)
    $match = [regex]::Match($Output, "(?m)\b(\d+)\s+$Name\b")
    if ($match.Success) { return [int]$match.Groups[1].Value }
    return 0
}

function Get-SafeCode {
    param([string]$StandardOutput, [string]$StandardError)
    $codes = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($stream in @($StandardOutput, $StandardError)) {
        foreach ($line in ($stream -split "`r?`n")) {
            $match = [regex]::Match($line, '^\s{0,32}AIVS_SAFE_RESULT code=([A-Z0-9_]+)\s*$')
            if (-not $match.Success) { continue }
            $candidate = $match.Groups[1].Value
            if (-not $script:FormalSafeCodes.Contains($candidate)) {
                return 'RUNNER_RESULT_UNCLASSIFIED'
            }
            [void]$codes.Add($candidate)
        }
    }
    if ($codes.Count -ne 1) { return 'RUNNER_RESULT_UNCLASSIFIED' }
    foreach ($code in $codes) { return $code }
    return 'RUNNER_RESULT_UNCLASSIFIED'
}

function Quote-WindowsArgument {
    param([string]$Value)
    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
        } elseif ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
        } else {
            if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)) }
            [void]$builder.Append($character)
            $slashes = 0
        }
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Join-WindowsArguments {
    param([string[]]$Arguments)
    return (($Arguments | ForEach-Object { Quote-WindowsArgument $_ }) -join ' ')
}

function Get-ProcessSummary {
    param([int]$ExitCode, [string]$StandardOutput, [string]$StandardError)
    $passed = Get-Count $StandardOutput 'passed'
    $failed = Get-Count $StandardOutput 'failed'
    $skipped = Get-Count $StandardOutput 'skipped'
    if ($ExitCode -eq 0 -and $passed -eq 1 -and $failed -eq 0) {
        return New-Summary 'passed' $true $ExitCode $passed $failed $skipped 'RUNNER_NONE' $true
    }
    return New-Summary 'failed' $true $ExitCode $passed $failed $skipped (
        Get-SafeCode $StandardOutput $StandardError
    ) $true
}

function Get-UserConfiguration {
    $values = @{}
    $complete = $true
    foreach ($name in $script:UserConfigNames) {
        $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::User)
        if ([string]::IsNullOrWhiteSpace($value)) { $complete = $false }
        $values[$name] = $value
    }
    $enabled = [Environment]::GetEnvironmentVariable(
        'AIVS_REAL_PROVIDER_ENABLED',
        [EnvironmentVariableTarget]::User
    )
    return [pscustomobject]@{
        Complete = $complete
        EnabledIsDisabled = ($enabled -eq '0')
        Values = $values
    }
}

function Invoke-CapturedProcess {
    param(
        [string]$FileName,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$EnvironmentValues
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FileName
    $info.Arguments = Join-WindowsArguments $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($name in $EnvironmentValues.Keys) {
        $info.EnvironmentVariables[$name] = $EnvironmentValues[$name]
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'start failed' }
    $script:PytestStarted = $true
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{
        Started = $true
        ExitCode = $process.ExitCode
        StandardOutput = $stdout
        StandardError = $stderr
    }
}

function Get-UvExecutablePath {
    $command = Get-Command uv.exe -CommandType Application -ErrorAction Stop
    return $command.Source
}

function Invoke-FixedPytest {
    param([hashtable]$Values)
    $root = Split-Path -Parent $PSScriptRoot
    $arguments = [string[]]@(
        'run', '--locked', '--extra', 'dev', 'pytest',
        'services/core/tests/integration/test_stage2a_real_provider_optin.py',
        '-m', 'real_provider', '-q'
    )
    $childEnvironment = @{ 'AIVS_REAL_PROVIDER_ENABLED' = '1' }
    foreach ($name in $script:UserConfigNames) { $childEnvironment[$name] = $Values[$name] }
    $result = Invoke-CapturedProcess (Get-UvExecutablePath) $arguments $root $childEnvironment
    try {
        return Get-ProcessSummary $result.ExitCode $result.StandardOutput $result.StandardError
    } catch {
        return New-Summary 'failed' $result.Started $result.ExitCode 0 0 0 'RUNNER_RESULT_UNCLASSIFIED' $true
    }
}

function Invoke-SelfTestProcess {
    param([string]$Mode)
    $child = Join-Path $PSScriptRoot 'real_provider_runner_selftest_child.ps1'
    $probe = 'quote " 中文 C:\path with space\'
    return Invoke-CapturedProcess 'powershell.exe' (
        [string[]]@('-NoProfile', '-File', $child, $mode, $probe)
    ) $PSScriptRoot @{}
}

function Test-RunnerInternals {
    $successResult = Invoke-SelfTestProcess 'success'
    $capturedResult = Invoke-SelfTestProcess 'stdout_captured'
    $duplicateResult = Invoke-SelfTestProcess 'duplicate'
    $conflictResult = Invoke-SelfTestProcess 'conflict'
    $unknownResult = Invoke-SelfTestProcess 'unknown'
    $success = Get-ProcessSummary $successResult.ExitCode $successResult.StandardOutput $successResult.StandardError
    $captured = Get-ProcessSummary $capturedResult.ExitCode $capturedResult.StandardOutput $capturedResult.StandardError
    $duplicate = Get-ProcessSummary $duplicateResult.ExitCode $duplicateResult.StandardOutput $duplicateResult.StandardError
    $conflict = Get-ProcessSummary $conflictResult.ExitCode $conflictResult.StandardOutput $conflictResult.StandardError
    $unknown = Get-ProcessSummary $unknownResult.ExitCode $unknownResult.StandardOutput $unknownResult.StandardError
    return (
        $successResult.Started -and $capturedResult.Started -and $duplicateResult.Started -and
        $conflictResult.Started -and $unknownResult.Started -and
        $success.status -eq 'passed' -and $success.exit_code -eq 0 -and $success.passed_count -eq 1 -and
        $captured.safe_code -eq 'REAL_PROVIDER_AUDIT_HTTP_FAILURE' -and
        $duplicate.safe_code -eq 'REAL_PROVIDER_AUDIT_HTTP_FAILURE' -and
        $conflict.safe_code -eq 'RUNNER_RESULT_UNCLASSIFIED' -and
        $unknown.safe_code -eq 'RUNNER_RESULT_UNCLASSIFIED'
    )
}

function Write-Summary {
    param([hashtable]$Summary)
    [Console]::Out.WriteLine(($Summary | ConvertTo-Json -Compress))
}

$summary = $null
$script:PytestStarted = $false
try {
    if ($SelfTest -and $Run) {
        $summary = New-Summary 'blocked' $false 2 0 0 0 'RUNNER_MODE_REQUIRED' $false
    } elseif ($SelfTest) {
        if (Test-RunnerInternals) {
            $summary = New-Summary 'self_test_passed' $false 0 1 0 0 'RUNNER_NONE' $false
        } else {
            $summary = New-Summary 'self_test_failed' $false 1 0 1 0 'RUNNER_SELFTEST_FAILED' $false
        }
    } elseif ($Run) {
        if (-not (Test-RunnerInternals)) {
            $summary = New-Summary 'blocked' $false 1 0 0 0 'RUNNER_SELFTEST_FAILED' $false
        } else {
            $configuration = Get-UserConfiguration
            if (-not $configuration.Complete) {
                $summary = New-Summary 'blocked' $false 2 0 0 0 'RUNNER_CONFIG_MISSING' $false
            } elseif (-not $configuration.EnabledIsDisabled) {
                $summary = New-Summary 'blocked' $false 2 0 0 0 'RUNNER_USER_ENABLEMENT_INVALID' $true
            } else {
                $summary = Invoke-FixedPytest $configuration.Values
            }
        }
    } else {
        $summary = New-Summary 'blocked' $false 2 0 0 0 'RUNNER_MODE_REQUIRED' $false
    }
} catch {
    $safeCode = if ($script:PytestStarted) { 'RUNNER_RESULT_UNCLASSIFIED' } else { 'RUNNER_START_FAILED' }
    $summary = New-Summary 'failed' $script:PytestStarted 1 0 0 0 $safeCode $false
}
Write-Summary $summary
exit [int]$summary.exit_code
