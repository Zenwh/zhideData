-- Bootstrap extensions for postgres-16. Runs once at first container start.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
