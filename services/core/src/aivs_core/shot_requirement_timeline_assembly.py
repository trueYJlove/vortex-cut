# Timeline Assembly History Service
# Implements version tracking and comparison for timeline assemblies

from sqlalchemy.orm import Session
from .database import Base
from sqlalchemy import Column, String, DateTime, JSON
from datetime import datetime
import uuid
import json

class AssemblyHistory(Base):
    __tablename__ = 'assembly_history'
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    assembly_id = Column(String(36), nullable=False)
    project_id = Column(String(36), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    snapshot_json = Column(JSON, nullable=False)
    user_id = Column(String(36), nullable=False)

class AssemblySuggestions(Base):
    __tablename__ = 'assembly_suggestions'
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), nullable=False)
    context_hash = Column(String(64), nullable=False)
    suggested_assembly_json = Column(JSON, nullable=False)
    confidence_score = Column(Float, nullable=False)
    last_used = Column(DateTime, nullable=True)

def create_history_entry(db: Session, assembly_id: str, project_id: str, snapshot: dict, user_id: str):
    """Creates new assembly history entry (append-only)"""
    entry = AssemblyHistory(
        assembly_id=assembly_id,
        project_id=project_id,
        snapshot_json=snapshot,
        user_id=user_id
    )
    db.add(entry)
    db.commit()
    return entry

def get_assembly_history(db: Session, assembly_id: str):
    """Retrieves all history versions for an assembly"""
    return db.query(AssemblyHistory).filter(
        AssemblyHistory.assembly_id == assembly_id
    ).order_by(AssemblyHistory.created_at.desc()).all()

def compare_assembly_versions(db: Session, version_id1: str, version_id2: str):
    """Compares two assembly versions and returns differences"""
    v1 = db.query(AssemblyHistory).get(version_id1)
    v2 = db.query(AssemblyHistory).get(version_id2)
    
    if not v1 or not v2:
        raise ValueError("Version not found")
    
    # Simple structural comparison
    diff = {
        "changed_elements": [],
        "added_elements": [],
        "removed_elements": []
    }
    
    # Implementation would compare snapshot_json structures
    # This is a placeholder for actual comparison logic
    
    return {
        "version1": version_id1,
        "version2": version_id2,
        "differences": diff,
        "timestamp_comparison": {
            "version1_time": v1.created_at.isoformat(),
            "version2_time": v2.created_at.isoformat()
        }
    }
