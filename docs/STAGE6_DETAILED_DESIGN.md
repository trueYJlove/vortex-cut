> 状态：历史草稿；已被 docs/STAGE6R_* 取代，不再作为 Stage 6 实施依据。

# STAGE6_DETAILED_DESIGN.md

## Stage 6: Timeline Assembly Enhancement

### 1. Design Overview
This document details the implementation plan for Stage 6 timeline assembly enhancements, building upon Stage 5's single-image assembly capability.

### 2. Core Architecture
#### 2.1 Database Schema (SQLite v17)
- **New Tables**:
  - ssembly_history (append-only):
    - id (UUID)
    - assembly_id (FK to shot_requirement_timeline_assemblies)
    - project_id
    - created_at
    - snapshot_json (JSONB)
    - user_id
  - ssembly_suggestions:
    - id (UUID)
    - project_id
    - context_hash
    - suggested_assembly_json
    - confidence_score
    - last_used

- **Migration Approach**:
  - Pure append-only migration (v16→v17)
  - No data migration required
  - Backward compatible with v16 schema

#### 2.2 Service Layer
- **Assembly History Service**:
  - CreateAssemblyHistory(version)
  - ListAssemblyHistory(assemblyId, limit)
  - RestoreAssemblyFromHistory(historyId)
  - CompareAssemblyVersions(version1, version2)

- **Assembly Suggestion Service**:
  - GenerateSuggestions(projectContext)
  - RecordSuggestionUsage(suggestionId)
  - UpdateSuggestionConfidence(suggestionId, success)

### 3. Contracts
#### 3.1 New API Version: stage6-v1
- **Endpoints**:
  - GET /assemblies/{id}/history
  - POST /assemblies/{id}/history/restore
  - GET /assemblies/suggestions
  - POST /assemblies/suggestions/usage

- **DTO Changes**:
  - Added history array to AssemblyResponse
  - Added suggestions array to AssemblyContextResponse
  - New HistoryEntry DTO with snapshot metadata

#### 3.2 Versioning Strategy
- Maintain stage5-v1 for backward compatibility
- New features only available via stage6-v1
- Clear version negotiation in Electron IPC

### 4. Desktop Implementation
#### 4.1 UI Components
- **Enhanced Assembly Panel**:
  - History timeline slider
  - Version comparison view
  - Suggestion cards with preview
  - History export/import functionality

- **New Components**:
  - AssemblyHistoryViewer
  - AssemblyVersionDiff
  - AssemblySuggestionList

#### 4.2 State Management
- New assembly history slice in Redux store
- Optimistic updates for history navigation
- Debounced suggestion fetching

### 5. Electron Integration
#### 5.1 New IPC Methods
- stage6:assembly-history-list
- stage6:assembly-history-restore
- stage6:assembly-suggestions-get
- stage6:assembly-suggestions-record-usage

#### 5.2 Security Considerations
- Strict input validation for history operations
- No direct filesystem access from renderer
- Context isolation for suggestion data

### 6. Testing Strategy
#### 6.1 Unit Tests
- Assembly history service operations
- Version comparison algorithms
- Suggestion generation logic
- Migration verification

#### 6.2 Integration Tests
- History creation and restoration flow
- Suggestion usage tracking
- Cross-version API compatibility
- Error handling for corrupted history

#### 6.3 E2E Tests
- History navigation in Electron
- Suggestion application workflow
- Version comparison UI
- History export/import functionality

### 7. Development Slices
#### 7.1 Phase 1: Foundation (Gate 6-2)
- Database schema definition
- Core service interfaces
- Basic history creation/restoration
- Initial suggestion service skeleton

#### 7.2 Phase 2: UI Implementation (Gate 6-3)
- History timeline UI
- Version comparison view
- Basic suggestion display
- Integration with existing assembly panel

#### 7.3 Phase 3: Advanced Features (Gate 6-4)
- Smart suggestion algorithms
- History export/import
- Performance optimizations
- Comprehensive error handling

### 8. Validation Evidence
#### 8.1 Gate 6-2 Prototype
- Working schema migration
- Basic history operations
- Simple suggestion framework
- Risk assessment report

#### 8.2 Gate 6-3 Production
- Complete UI implementation
- Full service integration
- Basic test coverage
- Documentation draft

#### 8.3 Gate 6-4 Validation
- Real-world usage testing
- Performance benchmarks
- Security verification
- Final documentation

### 9. Risk Assessment
#### 9.1 Identified Risks
- History data growth management
- Performance impact on large projects
- Suggestion accuracy challenges
- Cross-version compatibility issues

#### 9.2 Mitigation Strategies
- Automatic history pruning policy
- Background processing for suggestions
- Confidence threshold for suggestions
- Comprehensive version negotiation

### 10. Role Responsibilities
- **LiuWei**: Overall design approval, risk assessment
- **ZhangSan**: Core implementation, database schema, service layer
- **YeJing**: Desktop UI, Electron integration, contracts
- **LiuKeAi**: Independent verification, test coverage, documentation review

## Status
Design draft complete; awaiting Gate 6-2 prototype authorization
