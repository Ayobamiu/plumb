-- Per user, phase B: run only after the server that sends user_id is deployed.
-- New rows must name their user; the same id may now exist for two users.
alter table projects alter column user_id drop default;
alter table sources alter column user_id drop default;
alter table sources drop constraint sources_kind_external_id_key;
