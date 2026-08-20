# STAGE6_INDEPENDENT_ACCEPTANCE.md

## Stage 6: Timeline Assembly Enhancement Verification

### 1. Verification Scope
- Multi-image timeline assembly functionality
- Assembly history tracking and version comparison
- Smart assembly suggestions based on project context
- Assembly sharing between projects
- Backward compatibility with Stage 5 assemblies

### 2. Verification Approach
Independent verification performed by LiuKeAi following the frozen contract and design documents, without involvement in implementation.

### 3. Gate Verification Plan

#### 3.1 Gate 6-2: Prototype Verification
- [ ] Validate SQLite v17 migration schema
- [ ] Verify append-only history table design
- [ ] Confirm suggestion service interface compatibility
- [ ] Check risk mitigation strategies for identified risks
- [ ] Validate prototype against Stage 6 contract boundaries

#### 3.2 Gate 6-3: Production Implementation Verification
- [ ] Full Core implementation verification
- [ ] SQLite v17 migration and data integrity checks
- [ ] API contract validation (stage6-v1)
- [ ] Desktop UI component verification
- [ ] Electron IPC method validation
- [ ] Backward compatibility with Stage 5

#### 3.3 Gate 6-4: Independent Real Validation
- [ ] Fresh database validation (v17)
- [ ] Upgrade validation (v16→v17)
- [ ] Multi-image assembly workflow testing
- [ ] History navigation and version comparison
- [ ] Suggestion generation and application
- [ ] Assembly sharing functionality
- [ ] Windows packaging and installation validation
- [ ] Privacy and security verification
- [ ] Provider call verification (must remain 0)

#### 3.4 Gate 6-5: Final Regression Verification
- [ ] Full Core regression (460+ tests)
- [ ] Contracts/Desktop full regression (200+ tests)
- [ ] Stage 6-specific test suite
- [ ] SQLite v17 compatibility verification
- [ ] Privacy scan and evidence verification
- [ ] Documentation consistency check
- [ ] Git status and README verification

### 4. Verification Evidence Requirements

#### 4.1 Database Verification
- [ ] Schema version 17 checksum validation
- [ ] Foreign key constraint verification
- [ ] Database integrity check
- [ ] History table append-only verification
- [ ] Migration backup verification (for upgrades)

#### 4.2 API Verification
- [ ] stage6-v1 contract validation
- [ ] Version negotiation testing
- [ ] History endpoint validation
- [ ] Suggestion endpoint validation
- [ ] Error handling verification

#### 4.3 UI Verification
- [ ] History timeline slider functionality
- [ ] Version comparison view accuracy
- [ ] Suggestion card rendering
- [ ] History export/import functionality
- [ ] Performance under large project loads

#### 4.4 Security Verification
- [ ] No provider calls (0 delta verification)
- [ ] No sensitive data exposure
- [ ] History data sanitization
- [ ] Suggestion data isolation
- [ ] Cross-project sharing authorization

### 5. Verification Process

#### 5.1 Methodology
- Verification performed in read-only mode against frozen implementation
- Evidence collected from clean environment
- Verification focuses on contract compliance, not implementation details
- All verification steps documented with evidence paths

#### 5.2 Evidence Collection
- Core verification: `build/reports/stage6-gate*-core-*.json`
- Electron verification: `build/reports/stage6-gate*-electron-*.json`
- Privacy scan: `build/reports/stage6-privacy-scan.json`
- Database evidence: SHA-256 checksums of test databases

### 6. Gate 6-4 Verification Template

```json
{
  "schema_version": 1,
  "status": "passed",
  "target": "development_fresh",
  "checks": {
    "runtime_ready": true,
    "installed_runtime": false,
    "provider_network_disabled": true,
    "provider_call_delta": 0,
    "assembly_history_created": true,
    "assembly_version_comparison": true,
    "suggestion_generation": true,
    "assembly_sharing": true,
    "restart_restored": true,
    "sqlite_v17": true,
    "v16_in_place_upgrade": false,
    "prior_checksums_preserved": true,
    "migration_backup_created": null,
    "foreign_key_ok": true,
    "integrity_ok": true,
    "privacy_scan_passed": true
  },
  "database_sha256": "sha256:..."
}
```

### 7. Verification Constraints
- **Provider Calls**: Must remain 0 (no network calls)
- **Privacy**: No media paths, requirement bodies, or tokens in logs
- **Compatibility**: Must work with existing Stage 5 assemblies
- **Documentation**: All verification evidence must be documented

### 8. Verification Status
Gate 6-1 planning complete; awaiting Gate 6-2 prototype verification authorization
