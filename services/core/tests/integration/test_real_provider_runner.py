from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "tools" / "run_real_provider_once.ps1"
SELFTEST_CHILD = ROOT / "tools" / "real_provider_runner_selftest_child.ps1"


def _powershell() -> str:
    return "powershell.exe"


def test_real_provider_runner_is_fixed_and_does_not_accept_external_pytest_arguments() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "[switch]$SelfTest" in source and "[switch]$Run" in source
    assert "ProcessStartInfo" in source and "Join-WindowsArguments" in source
    assert "ArgumentList" not in source
    assert "EnvironmentVariables" in source and "$info.Environment[" not in source
    assert "$script:PytestStarted = $true" in source
    assert "Invoke-Expression" not in source
    assert "Start-Process" not in source and "cmd.exe" not in source
    assert "this script never retries" in source
    assert "services/core/tests/integration/test_stage2a_real_provider_optin.py" in source
    assert "'-m', 'real_provider', '-q'" in source
    assert "EnvironmentVariableTarget]::User" in source
    assert "'AIVS_REAL_PROVIDER_ENABLED' = '1'" in source
    for name in (
        "AIVS_REAL_PROVIDER_BASE_URL",
        "AIVS_REAL_PROVIDER_MODEL",
        "AIVS_REAL_PROVIDER_API_KEY",
        "AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION",
        "AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION",
        "AIVS_REAL_PROVIDER_EXPECTED_ADAPTER",
        "AIVS_REAL_PROVIDER_TIMEOUT",
    ):
        assert name in source


def test_real_provider_runner_quotes_windows_arguments_for_spaces_quotes_and_backslashes() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "function Quote-WindowsArgument" in source
    assert "$info.Arguments = Join-WindowsArguments $Arguments" in source
    assert "($slashes * 2) + 1" in source
    assert "($slashes * 2)" in source
    assert "real_provider_runner_selftest_child.ps1" in source
    assert "function Invoke-CapturedProcess" in source
    child = SELFTEST_CHILD.read_text(encoding="utf-8")
    assert 'quote " 中文 C:\\path with space\\' in child


def test_real_provider_runner_safe_code_parser_is_line_bound_and_dual_stream() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "param([string]$StandardOutput, [string]$StandardError)" in source
    assert '($stream -split "`r?`n")' in source
    assert "^\\s{0,32}AIVS_SAFE_RESULT code=([A-Z0-9_]+)\\s*$" in source
    assert "$codes.Count -ne 1" in source
    assert "Get-SafeCode $StandardOutput $StandardError" in source
    child = SELFTEST_CHILD.read_text(encoding="utf-8")
    for mode in ("stdout_captured", "duplicate", "conflict", "unknown"):
        assert f"'{mode}'" in child


def test_real_provider_runner_selftest_is_zero_network_and_only_emits_safe_summary() -> None:
    completed = subprocess.run(
        [_powershell(), "-NoProfile", "-File", str(SCRIPT), "-SelfTest"],
        capture_output=True,
        check=False,
        text=True,
    )
    assert completed.returncode == 0
    assert completed.stderr == ""
    assert completed.stdout.count("\n") == 1
    assert "sensitive" not in completed.stdout
    assert "中文" not in completed.stdout
    assert "path with space" not in completed.stdout
    assert "AIVS_SAFE_RESULT" not in completed.stdout
    summary = json.loads(completed.stdout)
    assert summary == {
        "schema_version": 1,
        "status": "self_test_passed",
        "pytest_started": False,
        "exit_code": 0,
        "passed_count": 1,
        "failed_count": 0,
        "skipped_count": 0,
        "safe_code": "RUNNER_NONE",
        "configuration_complete": False,
    }
