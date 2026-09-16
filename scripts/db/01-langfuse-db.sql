-- Langfuse's own database, folded into this project's existing Postgres
-- container instead of running a second Postgres (ADR 13). One `db`
-- container, two databases: `sdr` for the application, `langfuse` for
-- Langfuse's own schema.
--
-- Postgres only runs files under docker-entrypoint-initdb.d the first time a
-- data volume is initialized. On any clone where `pgdata` already has data
-- (i.e. every machine that had `db` running before T052 landed), this file
-- never executes and the database has to be created by hand once:
--
--   docker compose exec db psql -U sdr -d postgres -c "create database langfuse;"
--
-- See specs/004-conversation/quickstart.md §6. The guard below just makes a
-- fresh-volume run idempotent against being re-applied.
SELECT 'CREATE DATABASE langfuse OWNER sdr'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse')
\gexec
