-- Akasha tape. Hose is the only writer of these four tables.

create table if not exists chain_cursor (
  chain            text primary key,
  t0_hash          bytea not null,
  t0_height        bigint not null,
  tip_hash         bytea not null,
  tip_height       bigint not null,
  finalized_hash   bytea not null,
  finalized_height bigint not null,
  stream_alive     boolean not null default false,
  stream_kind      text not null
);

create table if not exists header (
  chain        text not null,
  hash         bytea not null,
  parent_hash  bytea not null,
  height       bigint not null,
  logs_bloom   bytea,
  receipts_root bytea,
  primary key (chain, hash)
);
create index if not exists header_height on header (chain, height);

create table if not exists event (
  chain                 text not null,
  block_hash            bytea not null,
  loc                   integer not null,
  height                bigint not null,
  tx_hash               bytea not null,
  kind                  text not null,
  contract_or_program   text not null,
  token_or_inscription  text not null,
  from_addr             text not null,
  to_addr               text not null,
  raw                   jsonb not null,
  primary key (chain, block_hash, loc)
);
create index if not exists event_contract on event (chain, contract_or_program, token_or_inscription);
create index if not exists event_height on event (chain, height);

create table if not exists artifact (
  id             text primary key,
  chain          text not null,
  kind           text not null,
  genesis_hash   bytea not null,
  genesis_loc    integer not null,
  first_hash     bytea not null,
  first_height   bigint not null
);

create table if not exists coverage_run (
  chain          text not null,
  from_height    bigint not null,
  to_height      bigint not null,
  to_hash        bytea not null,
  event_count    bigint not null,
  artifact_count bigint not null,
  receipt_digest bytea not null,
  primary key (chain, from_height)
);

create table if not exists gap_queue (
  id           bigserial primary key,
  chain        text not null,
  from_height  bigint not null,
  to_height    bigint not null,
  reason       text not null check (reason in ('reconnect','reorg','bloom_audit','seq_gap','attention_history')),
  enqueued_at  timestamptz not null default now(),
  attempts     integer not null default 0
);

create table if not exists cluster (
  cluster_id          text primary key,
  chain               text not null,
  announcement_kind   text not null,
  genesis_witnesses   jsonb not null,
  hard_members        jsonb not null,
  candidates          jsonb not null default '[]'
);

create table if not exists cluster_journal (
  id           bigserial primary key,
  op           text not null,
  at_height    bigint not null,
  cluster_ids  jsonb not null,
  reason       text not null,
  at           timestamptz not null default now()
);

create table if not exists observation (
  id              bigserial primary key,
  target          text not null,
  uri             text not null,
  body_sha256     text not null,
  observed_at     timestamptz not null,
  session_hmac    text not null,
  net24_hmac      text not null,
  asn_hmac        text not null,
  viewport_nonce  text not null,
  size            integer not null,
  parsed_ok       boolean not null,
  status          text not null check (status in ('unconfirmed','confirmed','disputed'))
);

create table if not exists claim_kit (
  id            bigserial primary key,
  kind          text not null,
  collection    text not null,
  as_of_chain   text not null,
  as_of_height  bigint not null,
  as_of_hash    bytea not null,
  program_id    text not null,
  input_digest  bytea not null,
  kit           jsonb not null
);

-- Completeness invariant as a view: one run from t0 to finalized, or the chain is not alive.
create or replace view coverage_health as
select
  c.chain,
  c.t0_height,
  c.finalized_height,
  c.stream_alive,
  coalesce((
    select min(from_height) from coverage_run r where r.chain = c.chain
  ), -1) as run_from,
  coalesce((
    select max(to_height) from coverage_run r where r.chain = c.chain
  ), -1) as run_to
from chain_cursor c;
