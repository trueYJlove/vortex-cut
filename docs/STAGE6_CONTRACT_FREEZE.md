# STAGE6_CONTRACT_FREEZE.md

## Stage 6: Timeline Assembly Enhancement

### 1. Recommended Scope
- Timeline assembly extension with multi-image support
- Assembly history tracking and version comparison
- Smart assembly suggestions based on project context
- Assembly sharing between projects

### 2. User Value
- Enables complex timeline compositions with multiple visual elements
- Improves workflow efficiency through assembly history and suggestions
- Facilitates collaborative editing through shared assemblies
- Maintains non-destructive editing workflow

### 3. Boundary with Stage 5
- Stage 5: Single image timeline assembly
- Stage 6: Multi-image assembly with enhanced features
- No changes to Stage 5 core functionality
- New assembly history tables (append-only)
- New assembly suggestion service

### 4. Technical Impact
- **Core/SQLite**: New v17 migrations with assembly_history and assembly_suggestions tables
- **Contracts**: New stage6-v1 API version with history endpoints
- **Desktop**: Enhanced assembly panel with history view and suggestion options
- **Electron**: New IPC methods for history navigation
- **Windows**: No new packaging requirements

### 5. Migration & Compatibility
- v16→v17 only appends new tables, no data migration needed
- Old assemblies remain accessible through Stage 5 API
- Assembly history is append-only with immutable snapshots
- Schema version checks prevent incompatible access

### 6. Privacy & Security
- Assembly history only stores metadata, not actual media
- No new provider calls (remains 0)
- Assembly sharing requires explicit user authorization
- No sensitive data exposure in logs or UI

### 7. Verification Plan
- Gate 6-1: Scope freeze and planning
- Gate 6-2: Prototype and risk validation
- Gate 6-3: Production implementation
- Gate 6-4: Independent real validation
- Gate 6-5: Final regression and documentation

### 8. Conclusion
Recommended. Builds directly on Stage 5 with clear boundaries, maintains zero provider calls, and delivers significant user value through enhanced assembly capabilities without compromising existing functionality.

## Status
Gate 6-1 planning complete; awaiting Gate 6-2 prototype authorization
