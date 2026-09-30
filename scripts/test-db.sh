#!/usr/bin/env bash
# Build a throwaway local database that behaves like Supabase, apply every
# migration and the seed, create one user per role, then run tests/db/*.sql.
#
#   PGHOST=/var/run/postgresql PGUSER=postgres scripts/test-db.sh
#
# Needs a local PostgreSQL 16 you can connect to as a superuser. Never point
# this at the shop's real database: it drops and recreates "snm_test".
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-snm_test}
q() { psql -v ON_ERROR_STOP=1 -q "$@"; }

PGOPTIONS="-c client_min_messages=warning" q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null

# What Supabase provides and plain Postgres doesn't: the authenticated role,
# auth.uid() read from the request's JWT, and default table grants.
q -d "$DB" >/dev/null <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant usage on schema public to authenticated;
alter default privileges in schema public grant all on tables to authenticated;
alter default privileges in schema public grant all on functions to authenticated;
SQL

for f in supabase/migrations/*.sql; do PGOPTIONS="-c client_min_messages=warning" q -d "$DB" -f "$f" >/dev/null; echo "applied $(basename "$f")"; done
q -d "$DB" -f supabase/seed.sql >/dev/null && echo "applied seed.sql"

q -d "$DB" >/dev/null <<'SQL'
insert into auth.users (id) values
 ('aaaaaaaa-0000-0000-0000-000000000001'), ('aaaaaaaa-0000-0000-0000-000000000002'), ('aaaaaaaa-0000-0000-0000-000000000003');
insert into users (id, shop_id, full_name, role) values
 ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Owner', 'owner'),
 ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Test pharmacist', 'pharmacist'),
 ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Test counter', 'counter_staff');
SQL

for t in tests/db/*.test.sql; do
  echo "== $(basename "$t")"
  psql -q -d "$DB" -f "$t" 2>&1 | sed -n 's/.*NOTICE:  //p'
done
