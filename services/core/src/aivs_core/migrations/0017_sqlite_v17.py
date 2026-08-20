# SQLite v17 migration
# - Adds assembly_history table (append-only)
# - Adds assembly_suggestions table

from alembic import op
import sqlalchemy as sa

def upgrade():
    op.create_table(
        'assembly_history',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('assembly_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('snapshot_json', sa.JSON(), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    
    op.create_table(
        'assembly_suggestions',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('context_hash', sa.String(length=64), nullable=False),
        sa.Column('suggested_assembly_json', sa.JSON(), nullable=False),
        sa.Column('confidence_score', sa.Float(), nullable=False),
        sa.Column('last_used', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )

def downgrade():
    op.drop_table('assembly_suggestions')
    op.drop_table('assembly_history')
